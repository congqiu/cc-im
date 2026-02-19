import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import { SessionManager } from '../session/session-manager.js';
import { RequestQueue } from '../queue/request-queue.js';
import { runClaude, type ClaudeRunHandle } from '../claude/cli-runner.js';
import { sendThinkingCard, streamContentUpdate, sendFinalCards, sendErrorCard, sendTextReply, sendPermissionCard, updatePermissionCard, fetchThreadDescription, type CardHandle, type ThreadContext } from './message-sender.js';
import { getClient } from './client.js';
import { buildCardV2 } from './card-builder.js';
import { destroySession, updateCardFull, disableStreaming } from './cardkit-manager.js';
import { registerPermissionSender } from '../hook/permission-server.js';
import { CommandHandler, type CostRecord } from '../commands/handler.js';
import { trackCost, formatToolStats, formatToolCallNotification, safeStringify } from '../shared/utils.js';
import { DEDUP_TTL_MS, CARDKIT_THROTTLE_MS, IMAGE_DIR } from '../constants.js';
import { setActiveChatId } from '../shared/active-chats.js';
import { createLogger } from '../logger.js';

const log = createLogger('EventHandler');

// ─── Lark SDK 事件类型 ───

interface LarkEventData {
  header?: { event_type?: string };
  type?: string;
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

// 费用跟踪（按用户累积）
const userCosts = new Map<string, CostRecord>();

// 跟踪正在执行的任务
interface TaskInfo {
  handle: ClaudeRunHandle;
  cardId: string;
  messageId: string;
  latestContent: string;
  settle: () => void;  // 添加 settle 函数，用于在停止时标记任务已完成
  startedAt: number;   // 任务启动时间，用于超时清理
}
const runningTasks = new Map<string, TaskInfo>();

// 定期清理超时任务（30分钟超时，每10分钟检查一次）
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const taskCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, task] of runningTasks) {
    if (now - task.startedAt > TASK_TIMEOUT_MS) {
      log.warn(`Auto-cleaning timeout task: ${key}`);
      task.handle.abort();
      task.settle();
      runningTasks.delete(key);
    }
  }
}, TASK_CLEANUP_INTERVAL_MS);
taskCleanupTimer.unref();

export function stopEventHandler(): void {
  clearInterval(taskCleanupTimer);
}

export function getRunningTaskCount(): number {
  return runningTasks.size;
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

export function createEventDispatcher(config: Config) {
  const accessControl = new AccessControl(config.allowedUserIds);
  const sessionManager = new SessionManager(config.claudeWorkDir, config.allowedBaseDirs);
  const requestQueue = new RequestQueue();

  // Create command handler with dependencies
  const commandHandler = new CommandHandler({
    config,
    sessionManager,
    requestQueue,
    sender: { sendTextReply },
    userCosts,
    runningTasksSize: 0, // Will be updated dynamically
  });

  // Register feishu permission sender
  registerPermissionSender('feishu', {
    sendPermissionCard,
    updatePermissionCard: (_chatId: string, messageId: string, toolName: string, decision: 'allow' | 'deny') =>
      updatePermissionCard(messageId, toolName, decision),
  });

  // Dedup: track processed message IDs with timestamps (max 1000 entries)
  const processedMessages = new Map<string, number>();
  const MAX_DEDUP_SIZE = 1000;

  const dispatcher = new Lark.EventDispatcher({
    // @ts-ignore - defaultCallback 是自定义选项
    // 添加通用事件监听器，捕获所有事件
    defaultCallback: async (data: LarkEventData) => {
      const eventType = data?.header?.event_type || data?.type || 'unknown';
      log.info(`Received event: ${eventType}`);

      // 如果是卡片交互事件，记录详细信息
      if (eventType.includes('card') || eventType.includes('action')) {
        log.info('Card/Action event data:', safeStringify(data, 2));
      }
    },
  });

  // 注册卡片交互事件处理器
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

      // 解析按钮的 value（SDK 可能返回对象或字符串，也可能被双重 JSON 编码）
      let actionData: { action: string; card_id?: string; message_id?: string };
      try {
        let parsed = action.value;
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed);
          // 如果解析结果仍是字符串，说明被双重编码了，需要再解析一次
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

      // 处理停止按钮
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

          // 保存当前内容
          const stoppedContent = taskInfo.latestContent || '(任务已停止，暂无输出)';

          // 先从 Map 中删除任务，防止 onComplete 覆盖
          runningTasks.delete(taskKey);

          // 标记任务已完成（settled=true 后 onComplete/onError 不会再更新卡片）
          taskInfo.settle();

          // 中止任务
          taskInfo.handle.abort();

          // 通过 CardKit API 关闭流式模式并更新卡片为已停止状态，然后清理 session
          const stoppedCard = buildCardV2({ content: stoppedContent, status: 'done', note: '⏹️ 已停止' });
          disableStreaming(cardId)
            .then(() => updateCardFull(cardId, stoppedCard))
            .catch((e) => log.warn('Stop card update failed:', e?.message ?? e))
            .finally(() => destroySession(cardId));
        } else {
          log.warn(`No running task found for key: ${taskKey}`);
          log.info(`Current running tasks: ${Array.from(runningTasks.keys()).join(', ')}`);
          // 任务已结束，返回空响应保持卡片不变
        }
      }
    },
  });

  dispatcher.register({
    'im.message.receive_v1': async (data: LarkMessageData) => {
      const message = data.message;
      const messageId = message.message_id;

      // Dedup
      if (processedMessages.has(messageId)) return;
      const now = Date.now();
      processedMessages.set(messageId, now);
      // Evict expired entries
      for (const [id, ts] of processedMessages) {
        if (now - ts > DEDUP_TTL_MS) {
          processedMessages.delete(id);
        } else {
          break; // Map preserves insertion order, so we can stop early
        }
      }
      // Enforce max size: remove oldest entries
      while (processedMessages.size > MAX_DEDUP_SIZE) {
        const oldest = processedMessages.keys().next().value;
        if (oldest !== undefined) processedMessages.delete(oldest);
        else break;
      }

      const chatId = message.chat_id;
      const senderId = data.sender?.sender_id?.open_id;
      const chatType = message.chat_type; // 'p2p' | 'group' | 'topic'
      const isGroup = chatType === 'group' || chatType === 'topic';
      const threadId = message.thread_id as string | undefined;
      const rootId = message.root_id as string | undefined;

      if (!senderId) return;

      // 仅私聊时追踪活跃聊天（启动通知只发私聊）
      if (!isGroup) setActiveChatId('feishu', chatId);

      // 群聊非话题消息：要求 @机器人 才响应
      if (isGroup && !threadId) {
        const mentions: Array<{ key: string; id: { open_id?: string }; name: string }> | undefined = message.mentions;
        if (!mentions || mentions.length === 0) {
          return;
        }
      }

      // Access control
      if (!accessControl.isAllowed(senderId)) {
        log.warn(`Access denied for user: ${senderId}`);
        await sendTextReply(chatId, '抱歉，您没有使用此机器人的权限。');
        return;
      }

      // 构造 threadCtx（如果在话题中）
      let threadCtx: ThreadContext | undefined;
      if (isGroup && threadId && rootId) {
        threadCtx = { rootMessageId: rootId, threadId };
      }

      // Parse message content
      const msgType = message.message_type;
      if (msgType !== 'text' && msgType !== 'image') {
        // 话题内的非文本消息（如创建话题的系统消息）直接忽略，不回复
        if (threadId) {
          return;
        }
        await sendTextReply(chatId, '目前仅支持文本和图片消息。');
        return;
      }

      let text: string;
      let isImageMessage = false;
      if (msgType === 'image') {
        // 下载图片并构造 prompt
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
      } else {
        try {
          text = JSON.parse(message.content).text;
        } catch {
          return;
        }

        // 去掉飞书 @ 占位符（如 @_user_1）
        text = text.replace(/@_user_\d+/g, '').trim();

        if (!text?.trim()) return;
      }

      log.info(`User ${senderId}${isImageMessage ? ' [image]' : ''}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

      // Update runningTasksSize for CommandHandler
      commandHandler.updateRunningTasksSize(runningTasks.size);

      // 统一命令分发（图片消息不走命令分发）
      if (!isImageMessage && await commandHandler.dispatch(text, chatId, senderId, 'feishu', handleClaudeRequest, threadCtx)) {
        return;
      }

      // 路由逻辑：话题 vs 非话题
      if (isGroup && threadId && rootId) {
        // 群聊话题内：使用话题会话
        await routeToThread(config, sessionManager, requestQueue, senderId, chatId, threadId, rootId, text);
      } else {
        // 群聊主聊天区 + P2P：使用默认会话
        await routeToDefault(config, sessionManager, requestQueue, senderId, chatId, text);
      }
    },
  });

  return dispatcher;
}

// ─── 路由函数 ───

async function routeToThread(
  config: Config,
  sessionManager: SessionManager,
  requestQueue: RequestQueue,
  userId: string,
  chatId: string,
  threadId: string,
  rootMessageId: string,
  text: string,
) {
  let threadSession = sessionManager.getThreadSession(userId, threadId);
  if (!threadSession) {
    // 首次遇到该话题：从 API 获取话题描述（根消息内容），获取不到时降级用首条用户消息
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
    // 回填：已有话题缺少描述
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
    await handleClaudeRequest(config, sessionManager, userId, chatId, prompt, workDir, undefined, threadCtx);
  });

  if (enqueueResult === 'rejected') {
    log.warn(`Queue full for user: ${userId}, thread: ${threadId}`);
    await sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。', threadCtx);
  } else if (enqueueResult === 'queued') {
    await sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。', threadCtx);
  }
}

async function routeToDefault(
  config: Config,
  sessionManager: SessionManager,
  requestQueue: RequestQueue,
  userId: string,
  chatId: string,
  text: string,
) {
  const workDirSnapshot = sessionManager.getWorkDir(userId);
  const convIdSnapshot = sessionManager.getConvId(userId);

  const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, text, async (prompt) => {
    await handleClaudeRequest(config, sessionManager, userId, chatId, prompt, workDirSnapshot, convIdSnapshot);
  });

  if (enqueueResult === 'rejected') {
    log.warn(`Queue full for user: ${userId}`);
    await sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
  } else if (enqueueResult === 'queued') {
    await sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
  }
}

async function handleClaudeRequest(
  config: Config,
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
  prompt: string,
  workDir: string,
  convId?: string,
  threadCtx?: ThreadContext,
) {
  // sessionId 获取：话题模式用 threadId，非话题用 convId
  const sessionId = threadCtx && threadCtx.threadId
    ? sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
    : convId
      ? sessionManager.getSessionIdForConv(userId, convId)
      : undefined;

  log.info(`Running Claude for user ${userId}, ${threadCtx ? `thread=${threadCtx.threadId}` : `convId=${convId}`}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

  // Send thinking card
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

  // 捕获最终的 threadCtx 用于闭包
  const finalThreadCtx = threadCtx;

  return new Promise<void>((resolve) => {
    let lastUpdateTime = 0;
    let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
    let latestContent = '';
    let settled = false;
    let firstContentLogged = false;
    let wasThinking = false;
    let thinkingText = '';
    let toolLines: string[] = [];
    const startTime = Date.now();
    const taskKey = `${userId}:${cardId}`;

    const cleanup = () => {
      if (pendingUpdate) {
        clearTimeout(pendingUpdate);
        pendingUpdate = null;
      }
      // 从运行任务列表中移除
      runningTasks.delete(taskKey);
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const throttledUpdate = (content: string) => {
      latestContent = content;

      // 更新 runningTasks 中的最新内容
      const taskInfo = runningTasks.get(taskKey);
      if (taskInfo) {
        taskInfo.latestContent = content;
      }

      const now = Date.now();
      const elapsed = now - lastUpdateTime;

      if (elapsed >= CARDKIT_THROTTLE_MS) {
        lastUpdateTime = now;
        if (pendingUpdate) {
          clearTimeout(pendingUpdate);
          pendingUpdate = null;
        }
        streamContentUpdate(cardId, latestContent, toolLines.slice(-3).join('\n') || undefined).catch((e) => log.warn('Stream update failed:', e?.message ?? e));
      } else if (!pendingUpdate) {
        pendingUpdate = setTimeout(() => {
          pendingUpdate = null;
          lastUpdateTime = Date.now();
          streamContentUpdate(cardId, latestContent, toolLines.slice(-3).join('\n') || undefined).catch((e) => log.warn('Stream update failed:', e?.message ?? e));
        }, CARDKIT_THROTTLE_MS - elapsed);
      }
    };

    const handle = runClaude(config.claudeCliPath, prompt, sessionId, workDir, {
      onSessionId: (id) => {
        if (finalThreadCtx?.threadId) {
          sessionManager.setSessionIdForThread(userId, finalThreadCtx.threadId, id);
          log.info(`Session created for user ${userId}, thread=${finalThreadCtx.threadId}: ${id}`);
        } else if (convId) {
          sessionManager.setSessionIdForConv(userId, convId, id);
          log.info(`Session created for user ${userId}, convId=${convId}: ${id}`);
        }
      },
      onThinking: (thinking) => {
        if (!firstContentLogged) {
          firstContentLogged = true;
          log.debug(`First content (thinking) for user ${userId} after ${Date.now() - startTime}ms`);
        }
        wasThinking = true;
        thinkingText = thinking;
        // 思考阶段也更新卡片，让用户看到 Claude 在想什么
        const display = `💭 **思考中...**\n\n${thinking}`;
        throttledUpdate(display);
      },
      onText: (accumulated) => {
        if (!firstContentLogged) {
          firstContentLogged = true;
          log.debug(`First content (text) for user ${userId} after ${Date.now() - startTime}ms`);
        }
        if (wasThinking) {
          wasThinking = false;
          // 思考→文本切换：内容前缀完全改变，CardKit 无法做增量渲染
          // 用 updateCardFull 重置卡片基线，后续流式更新才能正常增量
          if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = null;
          }
          const resetCard = buildCardV2({ content: accumulated || '...', status: 'streaming' }, cardId);
          updateCardFull(cardId, resetCard)
            .catch((e) => log.warn('Thinking→text transition update failed:', e?.message ?? e));
          lastUpdateTime = Date.now();
          latestContent = accumulated;
          const taskInfo = runningTasks.get(taskKey);
          if (taskInfo) taskInfo.latestContent = accumulated;
          return;
        }
        throttledUpdate(accumulated);
      },
      onToolUse: (toolName, toolInput) => {
        const notification = formatToolCallNotification(toolName, toolInput);
        toolLines.push(notification);
        // 保留最近 5 条工具调用通知
        if (toolLines.length > 5) toolLines = toolLines.slice(-5);
      },
      onComplete: async (result) => {
        if (settled) return;

        const toolInfo = formatToolStats(result.toolStats, result.numTurns);
        const noteParts: string[] = [];
        if (result.cost > 0) {
          noteParts.push(`耗时 ${(result.durationMs / 1000).toFixed(1)}s`);
          noteParts.push(`费用 $${result.cost.toFixed(4)}`);
        } else {
          noteParts.push('完成');
        }
        if (toolInfo) noteParts.push(toolInfo);
        if (result.model) noteParts.push(result.model);
        const note = noteParts.join(' | ');

        log.info(`Claude completed for user ${userId}: success=${result.success}, cost=$${result.cost.toFixed(4)}`);

        // 累积费用统计
        trackCost(userCosts, userId, result.cost, result.durationMs);

        // 优先使用流式累积的原始文本，避免 result.result 中的 HTML 实体编码
        const finalContent = result.accumulated || result.result || '(无输出)';
        try {
          await sendFinalCards(chatId, messageId, cardId, finalContent, note, finalThreadCtx, thinkingText || undefined);
        } catch (err) {
          log.error('Failed to send final cards:', err);
        }
        settle(); // 在卡片更新后再清理任务
      },
      onError: async (error) => {
        if (settled) return;

        log.error(`Claude error for user ${userId}: ${error}`);

        try {
          await sendErrorCard(cardId, error);
        } catch (err) {
          log.error('Failed to send error card:', err);
        }
        settle(); // 在卡片更新后再清理任务
      },
    }, {
      skipPermissions: config.claudeSkipPermissions,
      model: config.claudeModel,
      chatId,
      hookPort: config.hookPort,
      threadRootMsgId: finalThreadCtx?.rootMessageId,
      threadId: finalThreadCtx?.threadId,
      platform: 'feishu',
    });

    // 将任务 handle 和 settle 函数存储到 Map 中，以便能够在用户点击停止按钮时中止
    runningTasks.set(taskKey, { handle, cardId, messageId, latestContent: '', settle, startedAt: Date.now() });
  });
}
