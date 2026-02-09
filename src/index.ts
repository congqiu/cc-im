import { loadConfig } from './config.js';
import { initFeishu } from './feishu/client.js';
import { createEventDispatcher } from './feishu/event-handler.js';

function main() {
  console.log('[Main] Starting cc-feishu bridge service...');

  const config = loadConfig();
  console.log(`[Main] Allowed users: ${config.allowedUserIds.length === 0 ? 'ALL (dev mode)' : config.allowedUserIds.join(', ')}`);
  console.log(`[Main] Claude CLI: ${config.claudeCliPath}`);
  console.log(`[Main] Work directory: ${config.claudeWorkDir}`);

  const eventDispatcher = createEventDispatcher(config);
  initFeishu(config, eventDispatcher);

  console.log('[Main] Service is running. Press Ctrl+C to stop.');
}

main();
