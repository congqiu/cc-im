import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { WSClient } from './client.js';
import type { WecomEventHandlerHandle } from './client.js';
import { createWecomSender, type WecomSender, type WsFrame } from './message-sender.js';
import type { Config } from '../config.js';
import type { SessionManager } from '../session/session-manager.js';
import { AccessControl } from '../access/access-control.js';
import { RequestQueue } from '../queue/request-queue.js';
import { CommandHandler, type CostRecord } from '../commands/handler.js';
import { registerPermissionSender, resolvePermissionById } from '../hook/permission-server.js';
import { runClaudeTask, type TaskRunState } from '../shared/claude-task.js';
import { startTaskCleanup } from '../shared/task-cleanup.js';
import { MessageDedup } from '../shared/message-dedup.js';
import { WECOM_THROTTLE_MS, IMAGE_DIR } from '../constants.js';
import { setActiveChatId } from '../shared/active-chats.js';
import { createLogger } from '../logger.js';
import type { TextMessage, ImageMessage, MixedMessage, VoiceMessage } from '@wecom/aibot-node-sdk';
import type { EventMessageWith, TemplateCardEventData } from '@wecom/aibot-node-sdk';

const log = createLogger('WecomHandler');

/**
 * 从消息 body 中提取用户、聊天信息
 */
function extractInfo(body: Record<string, any>): {
  userId: string;
  chatId: string;
  isGroup: boolean;
  text: string;
  msgId: string;
} {
  const userId = body.from?.userid ?? '';
  const isGroup = body.chattype === 'group';
  const chatId = isGroup ? (body.chatid ?? userId) : userId;
  const text = body.text?.content ?? body.voice?.content ?? '';
  const msgId = body.msgid ?? '';
  return { userId, chatId, isGroup, text, msgId };
}

/**
 * 清理群聊消息文本
 * 企业微信智能机器人 SDK 在群聊中只会推送 @机器人的消息，
 * 所以只要收到群聊消息，就一定是被 mention 的，无需额外检查。
 */
function cleanGroupText(text: string): string {
  return text.trim();
}

/**
 * 下载企业微信图片到本地
 */
async function downloadWecomImage(wsClient: WSClient, url: string, aesKey?: string): Promise<string> {
  await mkdir(IMAGE_DIR, { recursive: true });
  const { buffer, filename } = await wsClient.downloadFile(url, aesKey);
  const ext = filename?.split('.').pop() ?? 'jpg';
  const safeFilename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const imagePath = join(IMAGE_DIR, safeFilename);
  await writeFile(imagePath, buffer);
  return imagePath;
}

export function setupWecomHandlers(
  wsClient: WSClient,
  config: Config,
  sessionManager: SessionManager,
): WecomEventHandlerHandle {
  const accessControl = new AccessControl(config.allowedUserIds);
  const requestQueue = new RequestQueue();
  const userCosts = new Map<string, CostRecord>();
  const runningTasks = new Map<string, TaskRunState>();
  const stopTaskCleanup = startTaskCleanup(runningTasks);
  const dedup = new MessageDedup();
  const sender: WecomSender = createWecomSender(wsClient);

  // accepting flag: 标记是否接受新消息
  let accepting = true;
  let taskCounter = 0;

  const commandHandler = new CommandHandler({
    config,
    sessionManager,
    requestQueue,
    sender: { sendTextReply: (chatId, text) => sender.sendTextReply(chatId, text) },
    userCosts,
    getRunningTasksSize: () => runningTasks.size,
  });

  // 注册权限发送器
  registerPermissionSender('wecom', {
    sendPermissionCard: (chatId, requestId, toolName, toolInput) =>
      sender.sendPermissionCard(chatId, requestId, toolName, toolInput),
    updatePermissionCard: (params) => sender.updatePermissionCard(params),
  });

  /**
   * 核心请求处理器（frame 可选，有 frame 时使用流式回复，无 frame 时退化为 sendMessage）
   */
  async function handleClaudeRequestCore(
    userId: string,
    chatId: string,
    prompt: string,
    workDir: string,
    convId: string | undefined,
    frame?: WsFrame,
  ) {
    const sessionId = convId ? sessionManager.getSessionIdForConv(userId, convId) : undefined;

    log.info(`Running Claude for user ${userId}, convId=${convId}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

    const taskKey = `${userId}:${++taskCounter}`;

    // 有 frame 时使用流式回复，无 frame 时 sender 内部会退化为 sendMessage
    if (frame) {
      sender.initStream(frame, taskKey);
    }

    await runClaudeTask(
      { config, sessionManager, userCosts },
      {
        userId,
        chatId,
        workDir,
        sessionId,
        convId,
        platform: 'wecom',
        taskKey,
      },
      prompt,
      {
        throttleMs: WECOM_THROTTLE_MS,
        streamUpdate: (content, toolNote) => {
          sender.sendStreamUpdate(content, toolNote).catch(() => {});
        },
        sendComplete: async (content, note) => {
          try {
            if (frame) {
              await sender.sendStreamComplete(content, note);
            } else {
              // 无 frame（命令触发），退化为 sendMessage
              const text = note ? `${content}\n\n─────────\n${note}` : content;
              await sender.sendTextReply(chatId, text);
            }
          } catch (err) {
            log.error('Failed to send complete:', err);
          }
        },
        sendError: async (error) => {
          try {
            if (frame) {
              await sender.sendStreamError(error);
            } else {
              await sender.sendTextReply(chatId, `❌ 错误\n\n${error}`);
            }
          } catch (err) {
            log.error('Failed to send error:', err);
          }
        },
        onThinkingToText: (content) => {
          sender.resetStreamForTextSwitch(content).catch(() => {});
        },
        extraCleanup: () => {
          sender.cleanupStream();
          runningTasks.delete(taskKey);
        },
        onTaskReady: (state) => {
          runningTasks.set(taskKey, state);
        },
      },
    );
  }

  // CommandHandler 使用的签名（无 frame）
  async function handleClaudeRequest(
    userId: string, chatId: string, prompt: string, workDir: string, convId?: string,
  ) {
    await handleClaudeRequestCore(userId, chatId, prompt, workDir, convId);
  }

  /**
   * 通用消息处理逻辑
   */
  async function handleMessage(frame: WsFrame, text: string, userId: string, chatId: string, msgId: string, isGroup: boolean) {
    if (!accepting) return;

    // 去重
    if (dedup.isDuplicate(`${chatId}:${msgId}`)) {
      log.debug(`Duplicate message ${msgId}, skipping`);
      return;
    }

    // 访问控制
    if (!accessControl.isAllowed(userId)) {
      log.warn(`Access denied for user ${userId}. Add to ALLOWED_USER_IDS to grant access.`);
      await sender.sendTextReply(chatId, '抱歉，您没有访问权限。\n\n请联系管理员将您的用户 ID 添加到白名单。\n您的 ID: ' + userId);
      return;
    }

    // 设置活跃聊天
    setActiveChatId('wecom', chatId);

    let cleanText = text.trim();

    // 群聊文本清理（企业微信 SDK 只推送 @机器人的消息，无需检查 mention）
    if (isGroup) {
      cleanText = cleanGroupText(cleanText);
    }

    if (!cleanText) return;

    log.debug(`Processing message from user ${userId}: ${cleanText.slice(0, 100)}${cleanText.length > 100 ? '...' : ''}`);

    // 处理 /stop 命令（企业微信特有，因为按钮可能不可用）
    if (cleanText === '/stop') {
      // 找到该用户最新的运行任务并停止（taskKey 格式为 userId:counter，取最大的）
      const prefix = `${userId}:`;
      let latestKey: string | null = null;
      for (const key of runningTasks.keys()) {
        if (key.startsWith(prefix)) {
          if (!latestKey || key > latestKey) latestKey = key;
        }
      }
      if (latestKey) {
        const task = runningTasks.get(latestKey)!;
        runningTasks.delete(latestKey);
        task.settle();
        task.handle.abort();
        await sender.sendTextReply(chatId, '⏹️ 已停止当前任务');
      } else {
        await sender.sendTextReply(chatId, '当前没有运行中的任务');
      }
      return;
    }

    // 统一命令分发
    if (await commandHandler.dispatch(cleanText, chatId, userId, 'wecom', handleClaudeRequest)) {
      return;
    }

    // 路由到 Claude
    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, cleanText, async (prompt) => {
      await handleClaudeRequestCore(userId, chatId, prompt, workDirSnapshot, convIdSnapshot, frame);
    });

    if (enqueueResult === 'rejected') {
      log.warn(`Queue full for user: ${userId}`);
      await sender.sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sender.sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  }

  // --- 注册事件监听器 ---

  // 文本消息
  wsClient.on('message.text', async (frame: WsFrame<TextMessage>) => {
    const body = frame.body;
    if (!body) return;
    const { userId, chatId, text, msgId, isGroup } = extractInfo(body);
    await handleMessage(frame, text, userId, chatId, msgId, isGroup);
  });

  // 语音消息（已转文字）
  wsClient.on('message.voice', async (frame: WsFrame<VoiceMessage>) => {
    const body = frame.body;
    if (!body) return;
    const { userId, chatId, msgId, isGroup } = extractInfo(body);
    const text = body.voice?.content ?? '';
    await handleMessage(frame, text, userId, chatId, msgId, isGroup);
  });

  // 图片消息
  wsClient.on('message.image', async (frame: WsFrame<ImageMessage>) => {
    const body = frame.body;
    if (!body) return;
    const { userId, chatId, msgId, isGroup } = extractInfo(body);

    if (!accepting) return;
    if (dedup.isDuplicate(`${chatId}:${msgId}`)) return;
    if (!accessControl.isAllowed(userId)) {
      await sender.sendTextReply(chatId, '抱歉，您没有访问权限。\n您的 ID: ' + userId);
      return;
    }

    setActiveChatId('wecom', chatId);

    const imageUrl = body.image?.url;
    const aesKey = body.image?.aeskey;
    if (!imageUrl) {
      log.warn('Image message without URL');
      return;
    }

    let imagePath: string;
    try {
      imagePath = await downloadWecomImage(wsClient, imageUrl, aesKey);
    } catch (err) {
      log.error('Failed to download image:', err);
      await sender.sendTextReply(chatId, '图片下载失败，请重试。');
      return;
    }

    const prompt = `用户发送了一张图片，已保存到 ${imagePath}。请用 Read 工具查看并分析图片内容。`;
    log.info(`User ${userId} [image]: ${prompt.slice(0, 100)}...`);

    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, prompt, async (p) => {
      await handleClaudeRequestCore(userId, chatId, p, workDirSnapshot, convIdSnapshot, frame);
    });

    if (enqueueResult === 'rejected') {
      await sender.sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sender.sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  });

  // 图文混排消息
  wsClient.on('message.mixed', async (frame: WsFrame<MixedMessage>) => {
    const body = frame.body;
    if (!body) return;
    const { userId, chatId, msgId, isGroup } = extractInfo(body);

    if (!accepting) return;
    if (dedup.isDuplicate(`${chatId}:${msgId}`)) return;
    if (!accessControl.isAllowed(userId)) {
      await sender.sendTextReply(chatId, '抱歉，您没有访问权限。\n您的 ID: ' + userId);
      return;
    }

    setActiveChatId('wecom', chatId);

    const msgItems = body.mixed?.msg_item ?? [];
    const textParts: string[] = [];
    const imagePaths: string[] = [];

    for (const item of msgItems) {
      if (item.msgtype === 'text' && item.text?.content) {
        textParts.push(item.text.content);
      } else if (item.msgtype === 'image' && item.image?.url) {
        try {
          const path = await downloadWecomImage(wsClient, item.image.url, item.image.aeskey);
          imagePaths.push(path);
        } catch (err) {
          log.error('Failed to download mixed image:', err);
        }
      }
    }

    // 群聊文本清理（企业微信 SDK 只推送 @机器人的消息，无需检查 mention）
    const textContent = isGroup
      ? cleanGroupText(textParts.join(' '))
      : textParts.join(' ').trim();

    let prompt: string;
    if (imagePaths.length > 0) {
      const imageDesc = imagePaths.map(p => `已保存到 ${p}`).join('，');
      const captionPart = textContent ? `（附言：${textContent}）` : '';
      prompt = `用户发送了 ${imagePaths.length} 张图片${captionPart}，${imageDesc}。请用 Read 工具查看并分析图片内容。`;
    } else {
      prompt = textContent;
    }

    if (!prompt) return;

    log.info(`User ${userId} [mixed]: ${prompt.slice(0, 100)}...`);

    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, prompt, async (p) => {
      await handleClaudeRequestCore(userId, chatId, p, workDirSnapshot, convIdSnapshot, frame);
    });

    if (enqueueResult === 'rejected') {
      await sender.sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sender.sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  });

  // 模板卡片事件（停止按钮、权限按钮）
  wsClient.on('event.template_card_event', async (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => {
    const body = frame.body;
    if (!body) return;

    const eventKey = body.event?.event_key ?? '';
    const userId = body.from?.userid ?? '';

    log.info(`Template card event from ${userId}: key=${eventKey}`);

    if (eventKey.startsWith('stop_')) {
      const taskKey = eventKey.replace('stop_', '');
      const taskInfo = runningTasks.get(taskKey);

      if (taskInfo) {
        runningTasks.delete(taskKey);
        taskInfo.settle();
        taskInfo.handle.abort();

        // 更新卡片为已停止状态
        try {
          await wsClient.updateTemplateCard(frame, {
            card_type: 'text_notice',
            main_title: { title: 'Claude Code' },
            sub_title_text: '⏹️ 已停止',
          });
        } catch (err) {
          log.warn('Failed to update stop card:', err);
        }
      } else {
        try {
          await wsClient.updateTemplateCard(frame, {
            card_type: 'text_notice',
            main_title: { title: 'Claude Code' },
            sub_title_text: '任务已完成或不存在',
          });
        } catch (err) {
          log.warn('Failed to update card:', err);
        }
      }
    } else if (eventKey.startsWith('perm_allow_') || eventKey.startsWith('perm_deny_')) {
      const isAllow = eventKey.startsWith('perm_allow_');
      const requestId = eventKey.replace(/^perm_(allow|deny)_/, '');
      const decision = isAllow ? 'allow' as const : 'deny' as const;
      const resolved = resolvePermissionById(requestId, decision);

      try {
        await wsClient.updateTemplateCard(frame, {
          card_type: 'text_notice',
          main_title: { title: resolved ? (isAllow ? '✅ 已允许' : '❌ 已拒绝') : '请求已过期' },
          sub_title_text: resolved ? `权限请求已${isAllow ? '允许' : '拒绝'}` : '请求已过期或不存在',
        });
      } catch (err) {
        log.warn('Failed to update permission card:', err);
      }
    }
  });

  return {
    stop: () => {
      accepting = false;
      stopTaskCleanup();
    },
    getRunningTaskCount: () => runningTasks.size,
  };
}
