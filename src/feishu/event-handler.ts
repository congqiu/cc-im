import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import type { SessionManager } from '../session/session-manager.js';
import { RequestQueue } from '../queue/request-queue.js';
import { sendThinkingCard, streamContentUpdate, sendFinalCards, sendErrorCard, sendTextReply, sendPermissionCard, updatePermissionCard, fetchThreadDescription, uploadAndSendImage, type CardHandle, type ThreadContext } from './message-sender.js';
import { getClient, getBotOpenId } from './client.js';
import { buildCardV2 } from './card-builder.js';
import { destroySession, updateCardFull, disableStreaming } from './cardkit-manager.js';
import { registerPermissionSender, resolvePermissionById } from '../hook/permission-server.js';
import { CommandHandler, type CostRecord } from '../commands/handler.js';
import { safeStringify } from '../shared/utils.js';
import { runClaudeTask, type TaskRunState, type TaskDeps } from '../shared/claude-task.js';
import { startTaskCleanup } from '../shared/task-cleanup.js';
import { MessageDedup } from '../shared/message-dedup.js';
import { CARDKIT_THROTTLE_MS, IMAGE_DIR } from '../constants.js';
import { setActiveChatId } from '../shared/active-chats.js';
import { createLogger } from '../logger.js';

const log = createLogger('EventHandler');

// ─── Lark SDK 事件类型 ───

interface LarkEventData {
  header?: { event_type?: string };
  type?: string;
}

interface LarkRecalledData {
  message_id?: string;
  chat_id?: string;
  recall_type?: 'message_owner' | 'group_owner' | 'group_manager' | 'enterprise_manager';
}

interface LarkCardActionData {
  action: { value: unknown };
  operator?: { open_id?: string };
  sender?: { sender_id?: { open_id?: string } };
}

interface LarkMessageData {
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    thread_id?: string;
    root_id?: string;
  };
  sender?: {
    sender_id?: { open_id?: string };
  };
}

/**
 * 从富文本消息（post）中一次遍历提取所有图片 image_key 和文字内容
 */
export function parsePostContent(postContent: { content?: unknown[][] }): { imageKeys: string[]; text: string | null } {
  const content = postContent?.content;
  if (!Array.isArray(content)) return { imageKeys: [], text: null };

  const imageKeys: string[] = [];
  const texts: string[] = [];

  for (const block of content) {
    if (!Array.isArray(block)) continue;
    for (const element of block) {
      if (!element || typeof element !== 'object') continue;
      const el = element as { tag?: string; image_key?: string; text?: string };
      if (el.tag === 'img' && el.image_key) {
        imageKeys.push(el.image_key);
      } else if (el.tag === 'text' && el.text) {
        texts.push(el.text);
      }
    }
  }

  return { imageKeys, text: texts.length > 0 ? texts.join('\n') : null };
}

async function downloadFeishuImage(messageId: string, imageKey: string): Promise<string> {
  await mkdir(IMAGE_DIR, { recursive: true });
  const safeKey = imageKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const imagePath = join(IMAGE_DIR, `${Date.now()}-${safeKey}.png`);
  const client = getClient();
  const res = await client.im.v1.messageResource.get({
    params: { type: 'image' },
    path: { message_id: messageId, file_key: imageKey },
  });
  await res.writeFile(imagePath);
  return imagePath;
}

// 跟踪正在执行的任务
interface TaskInfo extends TaskRunState {
  cardId: string;
  messageId: string;
}

export interface FeishuEventHandlerHandle {
  dispatcher: Lark.EventDispatcher;
  stop: () => void;
  getRunningTaskCount: () => number;
}

export function createEventDispatcher(config: Config, sessionManager: SessionManager): FeishuEventHandlerHandle {
  const accessControl = new AccessControl(config.allowedUserIds);
  const requestQueue = new RequestQueue();

  // 费用跟踪（按用户累积）
  const userCosts = new Map<string, CostRecord>();
  const runningTasks = new Map<string, TaskInfo>();
  const stopTaskCleanup = startTaskCleanup(runningTasks);
  const dedup = new MessageDedup();

  // Create command handler with dependencies
  const commandHandler = new CommandHandler({
    config,
    sessionManager,
    requestQueue,
    sender: { sendTextReply },
    userCosts,
    getRunningTasksSize: () => runningTasks.size,
  });

  // Register feishu permission sender
  registerPermissionSender('feishu', {
    sendPermissionCard,
    updatePermissionCard: ({ messageId, toolName, decision }) =>
      updatePermissionCard(messageId, toolName, decision),
  });

  // ─── 内部函数（闭包访问 runningTasks 等） ───

  async function handleClaudeRequest(
    userId: string,
    chatId: string,
    prompt: string,
    workDir: string,
    convId?: string,
    threadCtx?: ThreadContext,
  ) {
    const sessionId = threadCtx && threadCtx.threadId
      ? sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
      : convId
        ? sessionManager.getSessionIdForConv(userId, convId)
        : undefined;

    log.info(`Running Claude for user ${userId}, ${threadCtx ? `thread=${threadCtx.threadId}` : `convId=${convId}`}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

    let cardHandle: CardHandle;
    try {
      cardHandle = await sendThinkingCard(chatId, threadCtx);
    } catch (err) {
      log.error('Failed to send thinking card:', err);
      return;
    }

    const { messageId, cardId } = cardHandle;

    if (!cardId) {
      log.error('No card_id returned for thinking card');
      return;
    }

    const finalThreadCtx = threadCtx;
    const taskKey = `${userId}:${cardId}`;

    let waitingTimer: ReturnType<typeof setInterval> | null = null;

    await runClaudeTask(
      { config, sessionManager, userCosts },
      {
        userId,
        chatId,
        workDir,
        sessionId,
        convId,
        threadId: finalThreadCtx?.threadId,
        threadRootMsgId: finalThreadCtx?.rootMessageId,
        platform: 'feishu',
        taskKey,
      },
      prompt,
      {
        throttleMs: CARDKIT_THROTTLE_MS,
        streamUpdate: (content, toolNote) => {
          streamContentUpdate(cardId, content, toolNote).catch((e) => log.warn('Stream update failed:', e?.message ?? e));
        },
        sendComplete: async (content, note, thinkingText) => {
          try {
            await sendFinalCards(chatId, messageId, cardId, content, note, finalThreadCtx, thinkingText);
          } catch (err) {
            log.error('Failed to send final cards:', err);
          }
        },
        sendError: async (error) => {
          try {
            await sendErrorCard(cardId, error);
          } catch (err) {
            log.error('Failed to send error card:', err);
          }
        },
        onThinkingToText: (content) => {
          const resetCard = buildCardV2({ content: content || '...', status: 'streaming' }, cardId);
          updateCardFull(cardId, resetCard)
            .catch((e) => log.warn('Thinking→text transition update failed:', e?.message ?? e));
        },
        extraCleanup: () => {
          if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
          runningTasks.delete(taskKey);
        },
        onTaskReady: (state) => {
          runningTasks.set(taskKey, { ...state, cardId, messageId });

          // 等待首次内容期间，每3秒更新卡片显示已等待时间
          const startTime = Date.now();
          waitingTimer = setInterval(() => {
            const taskInfo = runningTasks.get(taskKey);
            if (!taskInfo) {
              if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
              return;
            }
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            streamContentUpdate(cardId, `等待 Claude 响应... (${elapsed}s)`).catch(() => {});
          }, 3000);
        },
        onFirstContent: () => {
          // 首次内容到达，清除等待计时器
          if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
        },
        sendImage: (imagePath) => uploadAndSendImage(chatId, imagePath, finalThreadCtx),
      },
    );
  }

  async function routeToThread(
    userId: string,
    chatId: string,
    threadId: string,
    rootMessageId: string,
    text: string,
  ) {
    let threadSession = sessionManager.getThreadSession(userId, threadId);
    if (!threadSession) {
      const description = await fetchThreadDescription(rootMessageId) ?? text;
      const displayName = description.slice(0, 20) + (description.length > 20 ? '...' : '');

      sessionManager.setThreadSession(userId, threadId, {
        workDir: sessionManager.getWorkDir(userId),
        rootMessageId,
        threadId,
        displayName,
        description,
      });
      threadSession = sessionManager.getThreadSession(userId, threadId)!;
    } else if (!threadSession.description) {
      const description = await fetchThreadDescription(rootMessageId);
      if (description) {
        threadSession.description = description;
        threadSession.displayName = description.slice(0, 20) + (description.length > 20 ? '...' : '');
        sessionManager.setThreadSession(userId, threadId, threadSession);
      }
    }

    const workDir = threadSession.workDir;
    const threadCtx: ThreadContext = { rootMessageId, threadId };

    const enqueueResult = requestQueue.enqueue(userId, threadId, text, async (prompt) => {
      await handleClaudeRequest(userId, chatId, prompt, workDir, undefined, threadCtx);
    });

    if (enqueueResult === 'rejected') {
      log.warn(`Queue full for user: ${userId}, thread: ${threadId}`);
      await sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。', threadCtx);
    } else if (enqueueResult === 'queued') {
      await sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。', threadCtx);
    }
  }

  async function routeToDefault(
    userId: string,
    chatId: string,
    text: string,
  ) {
    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, text, async (prompt) => {
      await handleClaudeRequest(userId, chatId, prompt, workDirSnapshot, convIdSnapshot);
    });

    if (enqueueResult === 'rejected') {
      log.warn(`Queue full for user: ${userId}`);
      await sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  }

  // ─── 事件注册 ───

  const dispatcher = new Lark.EventDispatcher({
    // @ts-ignore - defaultCallback 是自定义选项
    defaultCallback: async (data: LarkEventData) => {
      const eventType = data?.header?.event_type || data?.type || 'unknown';
      log.info(`Received event: ${eventType}`);

      if (eventType.includes('card') || eventType.includes('action')) {
        log.debug('Card/Action event data:', safeStringify(data, 2));
      }
    },
  });

  dispatcher.register({
    'card.action.trigger': async (data: LarkCardActionData) => {
      log.debug('Received card action trigger event:', safeStringify(data, 2));

      const action = data.action;
      const userId = data.operator?.open_id || data.sender?.sender_id?.open_id;

      log.info(`Card action - userId: ${userId}, action value: ${action?.value}`);

      if (!userId) {
        log.warn('No userId found in card action event');
        return;
      }

      let actionData: { action: string; card_id?: string; message_id?: string; requestId?: string };
      try {
        let parsed = action.value;
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed);
          if (typeof parsed === 'string') {
            parsed = JSON.parse(parsed);
          }
        }
        actionData = parsed as typeof actionData;
        if (typeof actionData?.action !== 'string') {
          log.warn('Invalid action data: missing or non-string "action" field:', safeStringify(parsed));
          return;
        }
        log.info(`Parsed action data:`, safeStringify(actionData));
      } catch (err) {
        log.error('Failed to parse action value:', err);
        return;
      }

      if (actionData.action === 'stop') {
        const cardId = actionData.card_id;
        if (!cardId) {
          log.warn('No card_id in stop action data');
          return;
        }
        const taskKey = `${userId}:${cardId}`;
        const taskInfo = runningTasks.get(taskKey);

        log.debug(`Stop button clicked - taskKey: ${taskKey}, handle exists: ${!!taskInfo}`);

        if (taskInfo) {
          log.info(`User ${userId} stopped task for card ${cardId}`);

          const stoppedContent = taskInfo.latestContent || '(任务已停止，暂无输出)';

          runningTasks.delete(taskKey);
          taskInfo.settle();
          taskInfo.handle.abort();

          const stoppedCard = buildCardV2({ content: stoppedContent, status: 'done', note: '⏹️ 已停止' });
          disableStreaming(cardId)
            .then(() => updateCardFull(cardId, stoppedCard))
            .catch((e) => log.warn('Stop card update failed:', e?.message ?? e))
            .finally(() => destroySession(cardId));
        } else {
          log.warn(`No running task found for key: ${taskKey}`);
          log.info(`Current running tasks: ${Array.from(runningTasks.keys()).join(', ')}`);
        }
      } else if (actionData.action === 'allow' || actionData.action === 'deny') {
        // 处理权限按钮点击
        const requestId = actionData.requestId;
        const decision = actionData.action as 'allow' | 'deny';

        if (!requestId) {
          log.warn('No requestId in permission action');
          return;
        }

        const resolvedId = resolvePermissionById(requestId, decision);
        if (resolvedId) {
          log.info(`Permission ${decision} via button for request ${requestId}`);
        } else {
          log.warn(`No pending permission request found for requestId: ${requestId}`);
        }
      }
    },
  });

  dispatcher.register({
    'im.message.recalled_v1': async (data: LarkRecalledData) => {
      const messageId = data?.message_id;
      if (!messageId) return;
      if (sessionManager.removeThreadByRootMessageId(messageId)) {
        log.info(`Thread session removed for recalled message: ${messageId}`);
      }
    },
  });

  dispatcher.register({
    'im.message.receive_v1': async (data: LarkMessageData) => {
      const message = data.message;
      const messageId = message.message_id;

      if (dedup.isDuplicate(messageId)) return;

      const chatId = message.chat_id;
      const senderId = data.sender?.sender_id?.open_id;
      const chatType = message.chat_type;
      const isGroup = chatType === 'group' || chatType === 'topic';
      const threadId = message.thread_id as string | undefined;
      const rootId = message.root_id as string | undefined;

      if (!senderId) return;

      if (!isGroup) setActiveChatId('feishu', chatId);

      if (isGroup && !threadId) {
        const mentions: Array<{ key: string; id: { open_id?: string }; name: string }> | undefined = message.mentions;
        if (!mentions || mentions.length === 0) {
          return;
        }
        const myOpenId = getBotOpenId();
        if (myOpenId && !mentions.some(m => m.id?.open_id === myOpenId)) {
          return;
        }
      }

      if (!accessControl.isAllowed(senderId)) {
        log.warn(`Access denied for user: ${senderId}`);
        await sendTextReply(chatId, '抱歉，您没有使用此机器人的权限。');
        return;
      }

      let threadCtx: ThreadContext | undefined;
      if (isGroup && threadId && rootId) {
        threadCtx = { rootMessageId: rootId, threadId };
      }

      const msgType = message.message_type;
      log.debug(`Message type: ${msgType}, threadId: ${threadId}, content: ${message.content?.slice(0, 200)}`);

      if (msgType !== 'text' && msgType !== 'image' && msgType !== 'post') {
        if (threadId) {
          log.debug(`Ignoring non-text/image/post message in thread: ${msgType}`);
          return;
        }
        await sendTextReply(chatId, '目前仅支持文本和图片消息。');
        return;
      }

      let text: string;
      let isImageMessage = false;
      if (msgType === 'image') {
        let imageKey: string;
        try {
          imageKey = JSON.parse(message.content).image_key;
        } catch {
          return;
        }
        if (!imageKey) return;

        try {
          const imagePath = await downloadFeishuImage(message.message_id, imageKey);
          text = `用户发送了一张图片，已保存到 ${imagePath}。请用 Read 工具查看并分析图片内容。`;
          isImageMessage = true;
        } catch (err) {
          log.error('Failed to download image:', err);
          await sendTextReply(chatId, '图片下载失败，请重试。', threadCtx);
          return;
        }
      } else if (msgType === 'post') {
        // 话题中发送的图片会被包装成富文本消息（post），解析其中的图片和文字
        try {
          const postContent = JSON.parse(message.content);
          const { imageKeys, text: textContent } = parsePostContent(postContent);

          log.debug(`Post message - images: ${imageKeys.length}, textContent: ${textContent?.slice(0, 100)}`);

          if (imageKeys.length > 0) {
            const imagePaths = await Promise.all(
              imageKeys.map(key => downloadFeishuImage(message.message_id, key))
            );
            const pathList = imagePaths.map(p => `- ${p}`).join('\n');
            if (textContent) {
              text = `用户发送了 ${imagePaths.length} 张图片和文字：\n\n图片路径：\n${pathList}\n\n文字内容：${textContent}\n\n请用 Read 工具查看图片并分析。`;
            } else {
              text = `用户发送了 ${imagePaths.length} 张图片，已保存到：\n${pathList}\n\n请用 Read 工具查看并分析图片内容。`;
            }
            isImageMessage = true;
          } else if (textContent) {
            text = textContent;
          } else {
            return;
          }
        } catch (err) {
          log.error('Failed to parse post message:', err);
          return;
        }
      } else {
        try {
          text = JSON.parse(message.content).text;
        } catch {
          return;
        }

        text = text.replace(/@_user_\d+/g, '').trim();

        if (!text?.trim()) return;
      }

      log.info(`User ${senderId}${isImageMessage ? ' [image]' : ''}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

      if (!isImageMessage && await commandHandler.dispatch(text, chatId, senderId, 'feishu', handleClaudeRequest, threadCtx)) {
        return;
      }

      if (isGroup && threadId && rootId) {
        await routeToThread(senderId, chatId, threadId, rootId, text);
      } else {
        await routeToDefault(senderId, chatId, text);
      }
    },
  });

  return {
    dispatcher,
    stop: () => stopTaskCleanup(),
    getRunningTaskCount: () => runningTasks.size,
  };
}
