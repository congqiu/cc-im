import type { AgentProvider } from '../config.js';
import { claudeRuntime } from './providers/claude.js';
import { codexRuntime } from './providers/codex.js';
import type { AgentRuntime } from './types.js';

const runtimes: Partial<Record<AgentProvider, AgentRuntime>> = {
  claude: claudeRuntime,
  codex: codexRuntime,
};

export function getAgentRuntime(provider: AgentProvider): AgentRuntime {
  const runtime = runtimes[provider];
  if (!runtime) {
    throw new Error(`当前 provider 暂未实现: ${provider}`);
  }
  return runtime;
}
