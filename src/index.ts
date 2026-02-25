import { loadConfig } from './config.js';
import { initFeishu, stopFeishu } from './feishu/client.js';
import { initTelegram, stopTelegram } from './telegram/client.js';
import { createEventDispatcher, type FeishuEventHandlerHandle } from './feishu/event-handler.js';
import { sendTextReply as feishuSendText } from './feishu/message-sender.js';
import { setupTelegramHandlers, type TelegramEventHandlerHandle } from './telegram/event-handler.js';
import { sendTextReply as telegramSendText } from './telegram/message-sender.js';
import { startPermissionServer } from './hook/permission-server.js';
import { ensureHookConfigured } from './hook/ensure-hook.js';
import { SessionManager } from './session/session-manager.js';
import { loadActiveChats, getActiveChatId } from './shared/active-chats.js';
import { cleanOldImages } from './shared/utils.js';
import { initLogger, createLogger, closeLogger } from './logger.js';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../package.json');

const log = createLogger('Main');

function getClaudeVersion(cliPath: string): string {
  try { return execFileSync(cliPath, ['--version'], { timeout: 5000 }).toString().trim(); } catch { return '未知'; }
}

async function sendLifecycleNotification(activeBots: string[], message: string) {
  const tasks: Promise<void>[] = [];
  for (const bot of activeBots) {
    const platform = bot.toLowerCase() as 'feishu' | 'telegram';
    const chatId = getActiveChatId(platform);
    if (!chatId) continue;
    const sender = platform === 'feishu' ? feishuSendText : telegramSendText;
    tasks.push(sender(chatId, message).catch((err) => {
      log.debug(`Failed to send ${bot} lifecycle notification:`, err);
    }));
  }
  await Promise.allSettled(tasks);
}

export async function main() {
  const config = loadConfig();
  initLogger(config.logDir, config.logLevel);
  loadActiveChats();
  log.info('Starting cc-im bridge service...');
  log.info(`Enabled platforms: ${config.enabledPlatforms.join(', ')}`);
  log.info(`Allowed users: ${config.allowedUserIds.length === 0 ? 'ALL (dev mode)' : config.allowedUserIds.length + ' users configured'}`);
  log.info(`Claude CLI: ${config.claudeCliPath}`);
  log.info(`Default work directory: ${config.claudeWorkDir}`);
  log.info(`Skip permissions: ${config.claudeSkipPermissions}`);
  log.info(`Timeout: ${config.claudeTimeoutMs}ms`);
  log.info(`Allowed base dirs: ${config.allowedBaseDirs.length} dirs configured`);

  let permissionServer: { close: () => void } | null = null;
  if (!config.claudeSkipPermissions) {
    ensureHookConfigured();
    permissionServer = await startPermissionServer(config.hookPort);
    log.info(`Permission hook server started on port ${config.hookPort}`);
  }

  // 创建共享的 SessionManager 单例
  const sessionManager = new SessionManager(config.claudeWorkDir, config.allowedBaseDirs);

  // Initialize enabled platforms in parallel
  const activeBots: string[] = [];
  const initTasks: Promise<{ platform: string; success: boolean }>[] = [];

  let feishuHandle: FeishuEventHandlerHandle | null = null;
  let telegramHandle: TelegramEventHandlerHandle | null = null;

  if (config.enabledPlatforms.includes('telegram')) {
    log.debug('Initializing Telegram platform...');
    if (config.allowedUserIds.length === 0) {
      log.warn('⚠️  ALLOWED_USER_IDS is empty - ALL users can access the bot (dev mode only!)');
    } else {
      log.info(`Telegram whitelist: ${config.allowedUserIds.filter(id => /^\d+$/.test(id)).length} users configured`);
    }
    initTasks.push(
      initTelegram(config, (bot) => {
        telegramHandle = setupTelegramHandlers(bot, config, sessionManager);
      })
        .then(() => {
          log.info('Telegram bot initialized');
          return { platform: 'Telegram', success: true };
        })
        .catch((err) => {
          log.error('Failed to initialize Telegram bot:', err);
          log.warn('Continuing without Telegram support');
          return { platform: 'Telegram', success: false };
        })
    );
  }

  if (config.enabledPlatforms.includes('feishu')) {
    initTasks.push(
      Promise.resolve()
        .then(async () => {
          feishuHandle = createEventDispatcher(config, sessionManager);
          await initFeishu(config, feishuHandle.dispatcher);
          log.info('Feishu bot initialized');
          return { platform: 'Feishu', success: true };
        })
        .catch((err) => {
          log.error('Failed to initialize Feishu bot:', err);
          log.warn('Continuing without Feishu support');
          return { platform: 'Feishu', success: false };
        })
    );
  }

  const results = await Promise.all(initTasks);
  for (const result of results) {
    if (result.success) {
      activeBots.push(result.platform);
    }
  }

  if (activeBots.length === 0) {
    log.error('No platforms were successfully initialized!');
    process.exit(1);
  }

  log.info(`Service is running with ${activeBots.join(' + ')}. Press Ctrl+C to stop.`);

  // 发送启动通知
  const startedAt = Date.now();
  const claudeVer = getClaudeVersion(config.claudeCliPath);
  const startupMsg = [
    `🟢 cc-im v${APP_VERSION} 服务已启动`,
    '',
    `平台: ${activeBots.join(' + ')}`,
    `工作目录: ${config.claudeWorkDir}`,
    `权限确认: ${config.claudeSkipPermissions ? '已跳过' : '已启用'}`,
    config.claudeModel ? `模型: ${config.claudeModel}` : '',
    `Claude CLI: ${claudeVer}`,
    `Node: ${process.version}`,
  ].filter(Boolean).join('\n');
  sendLifecycleNotification(activeBots, startupMsg).catch(() => {});

  const imageCleanupTimer = setInterval(() => {
    cleanOldImages().then((n) => { if (n > 0) log.info(`Cleaned ${n} old image(s)`); }).catch(() => {});
  }, 10 * 60 * 1000);
  imageCleanupTimer.unref();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down...');

    // 发送关闭通知
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = h > 0 ? `${h}h${m}m` : `${m}m`;
    await sendLifecycleNotification(activeBots, `🔴 cc-im 服务正在关闭...\n运行时长: ${uptimeStr}`).catch(() => {});

    // 停止接受新消息
    telegramHandle?.stop();
    if (config.enabledPlatforms.includes('telegram')) {
      stopTelegram();
    }
    feishuHandle?.stop();
    if (config.enabledPlatforms.includes('feishu')) {
      stopFeishu();
    }
    permissionServer?.close();

    // 等待运行中的任务完成（最多 30 秒）
    const maxWait = 30_000;
    const start = Date.now();
    const getTotalTasks = () => (feishuHandle?.getRunningTaskCount() ?? 0) + (telegramHandle?.getRunningTaskCount() ?? 0);
    let remaining = getTotalTasks();
    if (remaining > 0) {
      log.info(`Waiting for ${remaining} running task(s) to complete...`);
      while (remaining > 0 && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 500));
        remaining = getTotalTasks();
      }
      if (remaining > 0) {
        log.warn(`${remaining} task(s) still running after ${maxWait / 1000}s, forcing shutdown`);
      }
    }

    closeLogger();
    process.exit(0);
  };

  const onSignal = () => { shutdown().catch(() => process.exit(1)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// Run directly when executed as main module
const isDirectRun = process.argv[1]?.endsWith('/index.js') || process.argv[1]?.endsWith('/index.ts');
if (isDirectRun) {
  main();
}
