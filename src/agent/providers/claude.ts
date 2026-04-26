import { runClaude } from '../../claude/cli-runner.js';
import type { AgentRuntime } from '../types.js';

export const claudeRuntime: AgentRuntime = {
  provider: 'claude',
  run: (options, callbacks) => runClaude(
    options.cliPath,
    options.prompt,
    options.sessionId,
    options.workDir,
    callbacks,
    {
      skipPermissions: options.skipPermissions,
      timeoutMs: options.timeoutMs,
      model: options.model,
      chatId: options.chatId,
      hookPort: options.hookPort,
      threadRootMsgId: options.threadRootMsgId,
      threadId: options.threadId,
      platform: options.platform,
      proxyUrl: options.proxyUrl,
    },
  ),
};
