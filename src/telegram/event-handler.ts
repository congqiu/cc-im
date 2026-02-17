import type { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import type { Config } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import { SessionManager } from '../session/session-manager.js';
import { RequestQueue } from '../queue/request-queue.js';
import { runClaude, type ClaudeRunHandle } from '../claude/cli-runner.js';
import { sendThinkingMessage, updateMessage, sendFinalMessages, sendTextReply, sendPermissionMessage, updatePermissionMessage } from './message-sender.js';
import { registerPermissionSender } from '../hook/permission-server.js';
import { CommandHandler, type CostRecord, type CommandHandlerDeps } from '../commands/handler.js';
import { trackCost, formatToolStats } from '../shared/utils.js';
import { TERMINAL_ONLY_COMMANDS, DEDUP_TTL_MS, THROTTLE_MS } from '../constants.js';
import { createLogger } from '../logger.js';

const log = createLogger('TgHandler');

const userCosts = new Map<string, CostRecord>();

interface TaskInfo {
  handle: ClaudeRunHandle;
  latestContent: string;
  settle: () => void;
}
const runningTasks = new Map<string, TaskInfo>();

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

  const processedMessages = new Map<string, number>();

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
    const now = Date.now();
    if (processedMessages.has(messageId)) {
      log.debug(`Duplicate message ${messageId}, skipping`);
      return;
    }
    processedMessages.set(messageId, now);
    for (const [mid, ts] of processedMessages.entries()) {
      if (now - ts > DEDUP_TTL_MS) processedMessages.delete(mid);
    }

    // Access control
    if (!accessControl.isAllowed(userId)) {
      log.warn(`Access denied for user ${userId}. Add to ALLOWED_USER_IDS to grant access.`);
      await sendTextReply(chatId, '抱歉，您没有访问权限。\n\n请联系管理员将您的 Telegram ID 添加到白名单。\n您的 ID: ' + userId);
      return;
    }

    log.debug(`Processing message from authorized user ${userId}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

    // Update runningTasksSize for CommandHandler
    commandHandler.updateRunningTasksSize(runningTasks.size);

    // Handle /start
    if (text === '/start') {
      await sendTextReply(chatId, '欢迎使用 Claude Code Bot!\n\n发送消息与 Claude Code 交互，输入 /help 查看帮助。');
      return;
    }

    // Handle /help
    if (text === '/help') {
      await commandHandler.handleHelp(chatId, 'telegram');
      return;
    }

    // Handle /new
    if (text === '/new') {
      await commandHandler.handleNew(chatId, userId);
      return;
    }

    // Handle /cd
    if (text.startsWith('/cd ') || text === '/cd') {
      const args = text.slice(3);
      await commandHandler.handleCd(chatId, userId, args);
      return;
    }

    // Handle /pwd
    if (text === '/pwd') {
      await commandHandler.handlePwd(chatId, userId);
      return;
    }

    // Handle /list
    if (text === '/list') {
      await commandHandler.handleList(chatId, userId);
      return;
    }

    // Handle /cost
    if (text === '/cost') {
      await commandHandler.handleCost(chatId, userId);
      return;
    }

    // Handle /status
    if (text === '/status') {
      await commandHandler.handleStatus(chatId, userId);
      return;
    }

    // Handle /model
    if (text === '/model' || text.startsWith('/model ')) {
      const args = text.slice(6);
      await commandHandler.handleModel(chatId, args);
      return;
    }

    // Handle /doctor
    if (text === '/doctor') {
      await commandHandler.handleDoctor(chatId, userId);
      return;
    }

    // Handle /compact
    if (text === '/compact' || text.startsWith('/compact ')) {
      const args = text.slice(8);
      await commandHandler.handleCompact(chatId, userId, args, handleClaudeRequest);
      return;
    }

    // Handle /todos
    if (text === '/todos') {
      await commandHandler.handleTodos(chatId, userId, handleClaudeRequest);
      return;
    }

    // Handle /allow, /y
    if (text === '/allow' || text === '/y') {
      await commandHandler.handleAllow(chatId);
      return;
    }

    // Handle /deny, /n
    if (text === '/deny' || text === '/n') {
      await commandHandler.handleDeny(chatId);
      return;
    }

    // Handle /allowall
    if (text === '/allowall') {
      await commandHandler.handleAllowAll(chatId);
      return;
    }

    // Handle /pending
    if (text === '/pending') {
      await commandHandler.handlePending(chatId);
      return;
    }

    // Handle terminal-only commands
    const cmdName = text.split(/\s+/)[0];
    if (TERMINAL_ONLY_COMMANDS.has(cmdName)) {
      await sendTextReply(chatId, `${cmdName} 命令仅在终端交互模式下可用。\n\n输入 /help 查看可用命令。`);
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

    const startTime = Date.now();

    return new Promise<void>((resolve) => {
      let lastUpdateTime = 0;
      let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
      let latestContent = '';
      let settled = false;
      let firstContentLogged = false;
      const taskKey = `${userId}:${msgId}`;

      const cleanup = () => {
        if (pendingUpdate) {
          clearTimeout(pendingUpdate);
          pendingUpdate = null;
        }
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
        const taskInfo = runningTasks.get(taskKey);
        if (taskInfo) taskInfo.latestContent = content;

        const now = Date.now();
        const elapsed = now - lastUpdateTime;

        if (elapsed >= THROTTLE_MS) {
          lastUpdateTime = now;
          if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = null;
          }
          updateMessage(chatId, msgId, latestContent, 'streaming', '输出中...').catch(() => {});
        } else if (!pendingUpdate) {
          pendingUpdate = setTimeout(() => {
            pendingUpdate = null;
            lastUpdateTime = Date.now();
            updateMessage(chatId, msgId, latestContent, 'streaming', '输出中...').catch(() => {});
          }, THROTTLE_MS - elapsed);
        }
      };

      const handle = runClaude(config.claudeCliPath, prompt, sessionId, workDir, {
        onSessionId: (id) => {
          if (convId) {
            sessionManager.setSessionIdForConv(userId, convId, id);
            log.info(`Session created for user ${userId}, convId=${convId}: ${id}`);
          }
        },
        onThinking: (thinking) => {
          if (!firstContentLogged) {
            firstContentLogged = true;
            log.debug(`First content (thinking) for user ${userId} after ${Date.now() - startTime}ms`);
          }
          const display = `💭 **思考中...**\n\n${thinking}`;
          throttledUpdate(display);
        },
        onText: (accumulated) => {
          if (!firstContentLogged) {
            firstContentLogged = true;
            log.debug(`First content (text) for user ${userId} after ${Date.now() - startTime}ms`);
          }
          throttledUpdate(accumulated);
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

          trackCost(userCosts, userId, result.cost, result.durationMs);

          const finalContent = result.accumulated || result.result || '(无输出)';
          try {
            await sendFinalMessages(chatId, msgId, finalContent, note);
          } catch (err) {
            log.error('Failed to send final messages:', err);
          }
          settle();
        },
        onError: async (error) => {
          if (settled) return;
          try {
            await updateMessage(chatId, msgId, `错误：${error}`, 'error', '执行失败');
          } catch (err) {
            log.error('Failed to send error message:', err);
          }
          settle();
        },
      }, {
        skipPermissions: config.claudeSkipPermissions,
        model: config.claudeModel,
        chatId,
        hookPort: config.hookPort,
        platform: 'telegram',
      });

      runningTasks.set(taskKey, { handle, latestContent: '', settle });
    });
  }
}
