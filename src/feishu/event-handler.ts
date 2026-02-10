import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import { SessionManager } from '../session/session-manager.js';
import { RequestQueue } from '../queue/request-queue.js';
import { runClaude, type ClaudeRunHandle } from '../claude/cli-runner.js';
import { sendThinkingCard, updateCard, sendFinalCards, sendTextReply } from './message-sender.js';
import { createLogger } from '../logger.js';

const log = createLogger('EventHandler');

const THROTTLE_MS = 200;

// 跟踪正在执行的任务
interface TaskInfo {
  handle: ClaudeRunHandle;
  latestContent: string;
  settle: () => void;  // 添加 settle 函数，用于在停止时标记任务已完成
}
const runningTasks = new Map<string, TaskInfo>();

export function createEventDispatcher(config: Config) {
  const accessControl = new AccessControl(config.allowedUserIds);
  const sessionManager = new SessionManager(config.claudeWorkDir, config.allowedBaseDirs);
  const requestQueue = new RequestQueue();

  // Dedup: track processed message IDs with timestamps
  const processedMessages = new Map<string, number>();
  const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

  const dispatcher = new Lark.EventDispatcher({
    // @ts-ignore - defaultCallback 是自定义选项
    // 添加通用事件监听器，捕获所有事件
    defaultCallback: async (data: any) => {
      const eventType = data?.header?.event_type || data?.type || 'unknown';
      log.info(`Received event: ${eventType}`);

      // 如果是卡片交互事件，记录详细信息
      if (eventType.includes('card') || eventType.includes('action')) {
        log.info('Card/Action event data:', JSON.stringify(data, null, 2));
      }
    },
  });

  // 注册卡片交互事件处理器
  dispatcher.register({
    'card.action.trigger': async (data: any) => {
      log.info('Received card action trigger event:', JSON.stringify(data, null, 2));

      const action = data.action;
      const userId = data.operator?.open_id || data.sender?.sender_id?.open_id;

      log.info(`Card action - userId: ${userId}, action value: ${action?.value}`);

      if (!userId) {
        log.warn('No userId found in card action event');
        return;
      }

      // 解析按钮的 value（可能被双重 JSON 编码）
      let actionData: { action: string; message_id: string };
      try {
        let parsed = JSON.parse(action.value);
        // 如果解析结果是字符串，说明被双重编码了，需要再解析一次
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed);
        }
        actionData = parsed;
        log.info(`Parsed action data:`, actionData);
      } catch (err) {
        log.error('Failed to parse action value:', err);
        return;
      }

      // 处理停止按钮
      if (actionData.action === 'stop') {
        const messageId = actionData.message_id;
        const taskKey = `${userId}:${messageId}`;
        const taskInfo = runningTasks.get(taskKey);

        log.info(`Stop button clicked - taskKey: ${taskKey}, handle exists: ${!!taskInfo}`);

        if (taskInfo) {
          log.info(`User ${userId} stopped task for message ${messageId}`);

          // 保存当前内容
          const stoppedContent = taskInfo.latestContent || '(任务已停止，暂无输出)';

          // 先从 Map 中删除任务，防止 onComplete 覆盖
          runningTasks.delete(taskKey);

          // 标记任务已完成
          taskInfo.settle();

          // 中止任务
          taskInfo.handle.abort();

          // 更新卡片状态，显示已经输出的内容
          await updateCard(messageId, stoppedContent, 'error', '⏹️ 已停止 - 用户手动中止');
        } else {
          log.warn(`No running task found for key: ${taskKey}`);
          log.info(`Current running tasks: ${Array.from(runningTasks.keys()).join(', ')}`);
        }
      }
    },
  });

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
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

      const chatId = message.chat_id;
      const senderId = data.sender?.sender_id?.open_id;
      const chatType = message.chat_type; // 'p2p' or 'group'

      if (!senderId) return;

      // 群聊中只处理 @机器人 的消息
      if (chatType === 'group') {
        const mentions: Array<{ key: string; id: { open_id?: string }; name: string }> | undefined = message.mentions;
        if (!mentions || mentions.length === 0) return;
      }

      // Access control
      if (!accessControl.isAllowed(senderId)) {
        log.warn(`Access denied for user: ${senderId}`);
        await sendTextReply(chatId, '抱歉，您没有使用此机器人的权限。');
        return;
      }

      // Parse message content
      const msgType = message.message_type;
      if (msgType !== 'text') {
        await sendTextReply(chatId, '目前仅支持文本消息。');
        return;
      }

      let text: string;
      try {
        text = JSON.parse(message.content).text;
      } catch {
        return;
      }

      // 去掉飞书 @ 占位符（如 @_user_1）
      text = text.replace(/@_user_\d+/g, '').trim();

      if (!text?.trim()) return;

      log.info(`User ${senderId}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

      // Handle /clear command
      if (text.trim() === '/clear') {
        const cleared = sessionManager.clearSession(senderId);
        if (cleared) {
          log.info(`User ${senderId} cleared session successfully`);
          await sendTextReply(chatId, '✅ 会话已清除，下次对话将开始新的上下文。');
        } else {
          log.warn(`User ${senderId} tried to clear but no session exists`);
          await sendTextReply(chatId, '当前没有活动会话。');
        }
        return;
      }

      // Handle /cd command
      if (text.trim().startsWith('/cd ')) {
        const dir = text.trim().slice(4).trim();
        if (!dir) {
          await sendTextReply(chatId, `当前工作目录: ${sessionManager.getWorkDir(senderId)}`);
          return;
        }
        try {
          const resolved = sessionManager.setWorkDir(senderId, dir);
          log.info(`User ${senderId} changed workDir to: ${resolved}`);
          await sendTextReply(chatId, `工作目录已切换到: ${resolved}\n会话已重置。`);
        } catch (err: any) {
          await sendTextReply(chatId, err.message);
        }
        return;
      }

      // Handle /pwd command
      if (text.trim() === '/pwd') {
        await sendTextReply(chatId, `当前工作目录: ${sessionManager.getWorkDir(senderId)}`);
        return;
      }

      // Handle /list command
      if (text.trim() === '/list') {
        const dirs = listClaudeProjects(config.allowedBaseDirs);
        if (dirs.length === 0) {
          await sendTextReply(chatId, '未找到 Claude Code 工作区记录。');
        } else {
          const current = sessionManager.getWorkDir(senderId);
          const lines = dirs.map((d) => (d === current ? `▶ ${d}` : `  ${d}`));
          await sendTextReply(chatId, `Claude Code 工作区列表:\n${lines.join('\n')}\n\n使用 /cd <路径> 切换`);
        }
        return;
      }

      // Snapshot workDir at enqueue time so /cd during queue wait doesn't affect this task
      const workDirSnapshot = sessionManager.getWorkDir(senderId);

      // Enqueue the task
      const enqueueResult = requestQueue.enqueue(senderId, text, async (prompt) => {
        await handleClaudeRequest(config, sessionManager, senderId, chatId, prompt, workDirSnapshot);
      });

      if (enqueueResult === 'rejected') {
        log.warn(`Queue full for user: ${senderId}`);
        await sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
      } else if (enqueueResult === 'queued') {
        await sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
      }
    },
  });

  return dispatcher;
}

async function handleClaudeRequest(
  config: Config,
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
  prompt: string,
  workDir: string,
) {
  const sessionId = sessionManager.getSessionId(userId);

  log.info(`Running Claude for user ${userId}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

  // Send thinking card
  let messageId: string;
  try {
    messageId = await sendThinkingCard(chatId);
  } catch (err) {
    log.error('Failed to send thinking card:', err);
    return;
  }

  if (!messageId) {
    log.error('No message_id returned for thinking card');
    return;
  }

  return new Promise<void>((resolve) => {
    let lastUpdateTime = 0;
    let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
    let latestContent = '';
    let settled = false;
    const taskKey = `${userId}:${messageId}`;

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

      if (elapsed >= THROTTLE_MS) {
        lastUpdateTime = now;
        if (pendingUpdate) {
          clearTimeout(pendingUpdate);
          pendingUpdate = null;
        }
        updateCard(messageId, latestContent, 'streaming', '输出中...').catch(() => {});
      } else if (!pendingUpdate) {
        pendingUpdate = setTimeout(() => {
          pendingUpdate = null;
          lastUpdateTime = Date.now();
          updateCard(messageId, latestContent, 'streaming', '输出中...').catch(() => {});
        }, THROTTLE_MS - elapsed);
      }
    };

    const handle = runClaude(config.claudeCliPath, prompt, sessionId, workDir, {
      onSessionId: (id) => {
        sessionManager.setSessionId(userId, id);
        log.info(`Session created for user ${userId}: ${id}`);
      },
      onThinking: (thinking) => {
        // 思考阶段也更新卡片，让用户看到 Claude 在想什么
        const display = `💭 **思考中...**\n\n${thinking}`;
        throttledUpdate(display);
      },
      onText: (accumulated) => {
        throttledUpdate(accumulated);
      },
      onComplete: async (result) => {
        if (settled) return;
        cleanup();

        const note = result.cost > 0
          ? `耗时 ${(result.durationMs / 1000).toFixed(1)}s | 费用 $${result.cost.toFixed(4)}`
          : '完成';

        log.info(`Claude completed for user ${userId}: success=${result.success}, cost=$${result.cost.toFixed(4)}`);

        // 优先使用流式累积的原始文本，避免 result.result 中的 HTML 实体编码
        const finalContent = result.accumulated || result.result || '(无输出)';
        try {
          await sendFinalCards(chatId, messageId, finalContent, note);
        } catch (err) {
          log.error('Failed to send final cards:', err);
        }
        settle();
      },
      onError: async (error) => {
        if (settled) return;
        cleanup();

        log.error(`Claude error for user ${userId}: ${error}`);

        try {
          await updateCard(messageId, `错误：${error}`, 'error', '执行失败');
        } catch (err) {
          log.error('Failed to send error card:', err);
        }
        settle();
      },
    }, { skipPermissions: config.claudeSkipPermissions });

    // 将任务 handle 和 settle 函数存储到 Map 中，以便能够在用户点击停止按钮时中止
    runningTasks.set(taskKey, { handle, latestContent: '', settle });
  });
}

function listClaudeProjects(allowedBaseDirs: string[]): string[] {
  const configPath = join(homedir(), '.claude.json');
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    const projects: Record<string, unknown> = data.projects ?? {};
    return Object.keys(projects)
      .filter((dir) => allowedBaseDirs.some((base) => dir === base || dir.startsWith(base + '/')))
      .sort();
  } catch {
    return [];
  }
}
