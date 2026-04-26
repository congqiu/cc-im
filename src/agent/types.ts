import type { ChildProcess } from 'node:child_process';
import type { AgentProvider, CodexApprovalPolicy, CodexSandboxMode } from '../config.js';
import type { ParsedResult } from '../claude/stream-parser.js';

export interface AgentRunCallbacks {
  onText: (accumulated: string) => void;
  onThinking?: (accumulated: string) => void;
  onToolUse?: (toolName: string, toolInput?: Record<string, unknown>) => void;
  onComplete: (result: ParsedResult) => void;
  onError: (error: string) => void;
  onSessionId?: (sessionId: string) => void;
}

export interface AgentRunHandle {
  process: ChildProcess;
  abort: () => void;
}

export interface AgentRunOptions {
  provider: AgentProvider;
  cliPath: string;
  prompt: string;
  sessionId?: string;
  workDir: string;
  skipPermissions?: boolean;
  timeoutMs?: number;
  model?: string;
  chatId?: string;
  hookPort?: number;
  threadRootMsgId?: string;
  threadId?: string;
  platform?: string;
  proxyUrl?: string;
  codexSandbox?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
}

export interface AgentRuntime {
  provider: AgentProvider;
  run: (options: AgentRunOptions, callbacks: AgentRunCallbacks) => AgentRunHandle;
}
