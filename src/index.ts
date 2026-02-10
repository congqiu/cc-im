import { loadConfig } from './config.js';
import { initFeishu, stopFeishu } from './feishu/client.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { initLogger, createLogger, closeLogger } from './logger.js';

const log = createLogger('Main');

export function main() {
  initLogger();
  log.info('Starting cc-bot bridge service...');

  const config = loadConfig();
  log.info(`Allowed users: ${config.allowedUserIds.length === 0 ? 'ALL (dev mode)' : config.allowedUserIds.join(', ')}`);
  log.info(`Claude CLI: ${config.claudeCliPath}`);
  log.info(`Default work directory: ${config.claudeWorkDir}`);
  log.info(`Skip permissions: ${config.claudeSkipPermissions}`);
  log.info(`Timeout: ${config.claudeTimeoutMs}ms`);
  log.info(`Allowed base dirs: ${config.allowedBaseDirs.join(', ')}`);

  const eventDispatcher = createEventDispatcher(config);
  initFeishu(config, eventDispatcher);

  log.info('Service is running. Press Ctrl+C to stop.');

  // Graceful shutdown
  const shutdown = () => {
    log.info('Shutting down...');
    stopFeishu();
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
