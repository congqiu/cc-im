import { loadConfig } from './config.js';
import { initFeishu, stopFeishu } from './feishu/client.js';
import { initTelegram, stopTelegram } from './telegram/client.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { setupTelegramHandlers } from './telegram/event-handler.js';
import { startPermissionServer } from './hook/permission-server.js';
import { initLogger, createLogger, closeLogger } from './logger.js';

const log = createLogger('Main');

export async function main() {
  initLogger();
  log.info('Starting cc-bot bridge service...');

  const config = loadConfig();
  log.info(`Enabled platforms: ${config.enabledPlatforms.join(', ')}`);
  log.info(`Allowed users: ${config.allowedUserIds.length === 0 ? 'ALL (dev mode)' : config.allowedUserIds.length + ' users configured'}`);
  log.info(`Claude CLI: ${config.claudeCliPath}`);
  log.info(`Default work directory: ${config.claudeWorkDir}`);
  log.info(`Skip permissions: ${config.claudeSkipPermissions}`);
  log.info(`Timeout: ${config.claudeTimeoutMs}ms`);
  log.info(`Allowed base dirs: ${config.allowedBaseDirs.length} dirs configured`);

  /**
   * Permission Hook Server
   *
   * When CLAUDE_SKIP_PERMISSIONS is false (default), we start a local HTTP server
   * to handle permission confirmation requests from the Claude Code PreToolUse hook.
   *
   * How it works:
   * 1. Claude Code invokes the hook script before executing sensitive tools (Bash, Write, Edit, etc.)
   * 2. The hook script sends a permission request to this server
   * 3. The server sends a permission card/message to the user via the messaging platform
   * 4. User responds with /allow or /deny
   * 5. The decision is returned to the hook script, which returns it to Claude Code
   *
   * Important limitations:
   * - The server is started only once at application startup
   * - Changing CLAUDE_SKIP_PERMISSIONS at runtime requires restarting the application
   * - The server listens only on localhost (127.0.0.1) for security
   * - Permission requests timeout after 5 minutes if user doesn't respond
   *
   * Configuration:
   * - CLAUDE_SKIP_PERMISSIONS: Set to "true" to disable permission checks (NOT recommended)
   * - HOOK_SERVER_PORT: Port for the permission server (default: 18900)
   */
  if (!config.claudeSkipPermissions) {
    await startPermissionServer(config.hookPort);
    log.info(`Permission hook server started on port ${config.hookPort}`);
  }

  // Initialize enabled platforms in parallel
  const activeBots: string[] = [];
  const initTasks: Promise<{ platform: string; success: boolean }>[] = [];

  if (config.enabledPlatforms.includes('telegram')) {
    log.debug('Initializing Telegram platform...');
    if (config.allowedUserIds.length === 0) {
      log.warn('⚠️  ALLOWED_USER_IDS is empty - ALL users can access the bot (dev mode only!)');
    } else {
      log.info(`Telegram whitelist: ${config.allowedUserIds.filter(id => /^\d+$/.test(id)).length} users configured`);
    }
    initTasks.push(
      initTelegram(config, (bot) => setupTelegramHandlers(bot, config))
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
        .then(() => {
          const eventDispatcher = createEventDispatcher(config);
          initFeishu(config, eventDispatcher);
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

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down...');

    if (config.enabledPlatforms.includes('telegram')) {
      stopTelegram();
    }

    if (config.enabledPlatforms.includes('feishu')) {
      stopFeishu();
    }

    closeLogger();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run directly when executed as main module
const isDirectRun = process.argv[1]?.endsWith('/index.js') || process.argv[1]?.endsWith('/index.ts');
if (isDirectRun) {
  main();
}
