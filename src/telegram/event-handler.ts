import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Config } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import { SessionManager } from '../session/session-manager.js';
import { RequestQueue } from '../queue/request-queue.js';
import { runClaude, type ClaudeRunHandle } from '../claude/cli-runner.js';
import { sendThinkingMessage, updateMessage, sendFinalMessages, sendTextReply, sendPermissionMessage, updatePermissionMessage, startTypingLoop } from './message-sender.js';
import { registerPermissionSender } from '../hook/permission-server.js';
import { CommandHandler, type CostRecord } from '../commands/handler.js';
import { runClaudeTask, type TaskRunState } from '../shared/claude-task.js';
import { startTaskCleanup } from '../shared/task-cleanup.js';
import { MessageDedup } from '../shared/message-dedup.js';
import { THROTTLE_MS, IMAGE_DIR } from '../constants.js';
import { setActiveChatId } from '../shared/active-chats.js';
import { createLogger } from '../logger.js';

const log = createLogger('TgHandler');

const userCosts = new Map<string, CostRecord>();

type TaskInfo = TaskRunState;
const runningTasks = new Map<string, TaskInfo>();

// 定期清理超时任务
const stopTaskCleanup = startTaskCleanup(runningTasks);

export function stopTelegramEventHandler(): void {
  stopTaskCleanup();
}

export function getRunningTaskCount(): number {
  return runningTasks.size;
}

async function downloadTelegramPhoto(bot: Telegraf, fileId: string): Promise<string> {
  await mkdir(IMAGE_DIR, { recursive: true });
  const fileLink = await bot.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href, { signal: AbortSignal.timeout(30000) });
  const buffer = Buffer.from(await response.arrayBuffer());
  const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const imagePath = join(IMAGE_DIR, `${Date.now()}-${safeId.slice(-8)}.jpg`);
  await writeFile(imagePath, buffer);
  return imagePath;
}

export function setupTelegramHandlers(bot: Telegraf, config: Config) {
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

  // Register telegram permission sender
  registerPermissionSender('telegram', {
    sendPermissionCard: sendPermissionMessage,
    updatePermissionCard: updatePermissionMessage,
  });

  const dedup = new MessageDedup();

  // Handle callback queries (stop button)
  bot.on('callback_query', async (ctx) => {
    const query = ctx.callbackQuery;
    if (!('data' in query)) return;

    const userId = String(ctx.from?.id ?? '');
    const data = query.data;

    log.info(`Callback query from ${userId}: ${data}`);

    if (data.startsWith('stop_')) {
      const messageId = data.replace('stop_', '');
      const taskKey = `${userId}:${messageId}`;
      const taskInfo = runningTasks.get(taskKey);

      if (taskInfo) {
        runningTasks.delete(taskKey);
        taskInfo.settle();
        taskInfo.handle.abort();

        const chatId = String(ctx.chat?.id ?? '');
        await updateMessage(chatId, messageId, taskInfo.latestContent || '已停止', 'error', '⏹️ 已停止');
        await ctx.answerCbQuery('已停止执行');
      } else {
        await ctx.answerCbQuery('任务已完成或不存在');
      }
    }
  });

  // Handle text messages
  bot.on(message('text'), async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userId = String(ctx.from.id);
    const messageId = String(ctx.message.message_id);
    const text = ctx.message.text.trim();

    log.debug(`Received message from user ${userId}, chat ${chatId}: ${text.slice(0, 50)}${text.length > 50 ? '...' : ''}`);

    // Only allow private chats
    if (ctx.chat.type !== 'private') {
      log.warn(`Rejected message from non-private chat: ${ctx.chat.type}, chatId=${chatId}`);
      await sendTextReply(chatId, '抱歉，本机器人仅支持私聊模式。\n\n请在私聊窗口中与我对话。');
      return;
    }

    // Dedup
    if (dedup.isDuplicate(messageId)) {
      log.debug(`Duplicate message ${messageId}, skipping`);
      return;
    }

    // Access control
    if (!accessControl.isAllowed(userId)) {
      log.warn(`Access denied for user ${userId}. Add to ALLOWED_USER_IDS to grant access.`);
      await sendTextReply(chatId, '抱歉，您没有访问权限。\n\n请联系管理员将您的 Telegram ID 添加到白名单。\n您的 ID: ' + userId);
      return;
    }

    // 追踪活跃聊天
    setActiveChatId('telegram', chatId);

    log.debug(`Processing message from authorized user ${userId}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

    // Update runningTasksSize for CommandHandler
    commandHandler.updateRunningTasksSize(runningTasks.size);

    // 统一命令分发
    if (await commandHandler.dispatch(text, chatId, userId, 'telegram', handleClaudeRequest)) {
      return;
    }

    // Route to Claude
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
  });

  // Handle photo messages
  bot.on(message('photo'), async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userId = String(ctx.from.id);
    const messageId = String(ctx.message.message_id);
    const caption = ctx.message.caption?.trim() || '';

    // Only allow private chats
    if (ctx.chat.type !== 'private') {
      await sendTextReply(chatId, '抱歉，本机器人仅支持私聊模式。');
      return;
    }

    // Dedup
    if (dedup.isDuplicate(messageId)) return;

    // Access control
    if (!accessControl.isAllowed(userId)) {
      await sendTextReply(chatId, '抱歉，您没有访问权限。\n\n请联系管理员将您的 Telegram ID 添加到白名单。\n您的 ID: ' + userId);
      return;
    }

    setActiveChatId('telegram', chatId);

    // Download photo
    const photos = ctx.message.photo;
    const largestPhoto = photos[photos.length - 1];

    let imagePath: string;
    try {
      imagePath = await downloadTelegramPhoto(bot, largestPhoto.file_id);
    } catch (err) {
      log.error('Failed to download photo:', err);
      await sendTextReply(chatId, '图片下载失败，请重试。');
      return;
    }

    const prompt = caption
      ? `用户发送了一张图片（附言：${caption}），已保存到 ${imagePath}。请用 Read 工具查看并分析图片内容。`
      : `用户发送了一张图片，已保存到 ${imagePath}。请用 Read 工具查看并分析图片内容。`;

    log.info(`User ${userId} [photo]: ${prompt.slice(0, 100)}...`);

    // Route to Claude
    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, prompt, async (p) => {
      await handleClaudeRequest(config, sessionManager, userId, chatId, p, workDirSnapshot, convIdSnapshot);
    });

    if (enqueueResult === 'rejected') {
      await sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  });

  async function handleClaudeRequest(
    config: Config,
    sessionManager: SessionManager,
    userId: string,
    chatId: string,
    prompt: string,
    workDir: string,
    convId?: string,
  ) {
    const sessionId = convId ? sessionManager.getSessionIdForConv(userId, convId) : undefined;

    log.info(`Running Claude for user ${userId}, convId=${convId}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

    let msgId: string;
    try {
      msgId = await sendThinkingMessage(chatId);
    } catch (err) {
      log.error('Failed to send thinking message:', err);
      return;
    }

    if (!msgId) {
      log.error('No message_id returned for thinking message');
      return;
    }

    const stopTyping = startTypingLoop(chatId);
    const taskKey = `${userId}:${msgId}`;

    await runClaudeTask(
      config,
      sessionManager,
      {
        userId,
        chatId,
        workDir,
        sessionId,
        convId,
        platform: 'telegram',
        taskKey,
      },
      prompt,
      {
        throttleMs: THROTTLE_MS,
        streamUpdate: (content, toolNote) => {
          const note = toolNote
            ? '输出中...\n' + toolNote
            : '输出中...';
          updateMessage(chatId, msgId, content, 'streaming', note).catch(() => {});
        },
        sendComplete: async (content, note) => {
          try {
            await sendFinalMessages(chatId, msgId, content, note);
          } catch (err) {
            log.error('Failed to send final messages:', err);
          }
        },
        sendError: async (error) => {
          try {
            await updateMessage(chatId, msgId, `错误：${error}`, 'error', '执行失败');
          } catch (err) {
            log.error('Failed to send error message:', err);
          }
        },
        extraCleanup: () => {
          stopTyping();
          runningTasks.delete(taskKey);
        },
      },
      userCosts,
      (state) => {
        runningTasks.set(taskKey, state);
      },
    );
  }
}
