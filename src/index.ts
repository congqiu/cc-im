import { loadConfig } from './config.js';
import { initFeishu } from './feishu/client.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { initLogger, createLogger } from './logger.js';

const log = createLogger('Main');

function main() {
  initLogger();
  log.info('Starting cc-feishu bridge service...');

  const config = loadConfig();
  log.info(`Allowed users: ${config.allowedUserIds.length === 0 ? 'ALL (dev mode)' : config.allowedUserIds.join(', ')}`);
  log.info(`Claude CLI: ${config.claudeCliPath}`);
  log.info(`Default work directory: ${config.claudeWorkDir}`);

  const eventDispatcher = createEventDispatcher(config);
  initFeishu(config, eventDispatcher);

  log.info('Service is running. Press Ctrl+C to stop.');
}

main();
