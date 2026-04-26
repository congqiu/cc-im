import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logger.js';
import type { AgentRunCallbacks, AgentRunHandle, AgentRunOptions, AgentRuntime } from '../types.js';
import type { ParsedResult } from '../../claude/stream-parser.js';

const log = createLogger('CodexRuntime');

function getEventName(event: Record<string, unknown>): string {
  const direct = event.type ?? event.event ?? event.name;
  return typeof direct === 'string' ? direct : '';
}

function extractSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['thread_id', 'session_id', 'id']) {
    const val = record[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  for (const nestedKey of ['thread', 'session', 'data']) {
    const nested = extractSessionId(record[nestedKey]);
    if (nested) return nested;
  }
  return undefined;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;

  for (const key of ['text', 'content', 'message', 'output_text', 'summary']) {
    const val = record[key];
    const text = extractText(val);
    if (text) return text;
  }

  if (Array.isArray(record.content)) {
    const text = record.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const item = part as Record<string, unknown>;
        return typeof item.text === 'string'
          ? item.text
          : typeof item.content === 'string'
            ? item.content
            : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }

  return '';
}

function extractToolPayload(event: Record<string, unknown>): { name: string; input?: Record<string, unknown> } | null {
  const eventName = getEventName(event);
  const item = (event.item && typeof event.item === 'object' ? event.item : undefined) as Record<string, unknown> | undefined;
  const source = item ?? event;
  const itemType = typeof source.type === 'string' ? source.type : '';
  const toolName = typeof source.tool_name === 'string'
    ? source.tool_name
    : typeof source.name === 'string'
      ? source.name
      : itemType;

  const toolInput = (source.tool_input && typeof source.tool_input === 'object'
    ? source.tool_input
    : source.input && typeof source.input === 'object'
      ? source.input
      : undefined) as Record<string, unknown> | undefined;

  const toolishTypes = new Set(['command_execution', 'mcp_tool_call', 'file_change', 'web_search_call', 'apply_patch']);
  if (toolishTypes.has(itemType) || toolishTypes.has(eventName)) {
    return { name: toolName || itemType || eventName || 'tool', input: toolInput };
  }

  return null;
}

function buildResult(content: string, usageSource?: Record<string, unknown>): ParsedResult {
  const inputTokens = typeof usageSource?.input_tokens === 'number' ? usageSource.input_tokens : 0;
  const outputTokens = typeof usageSource?.output_tokens === 'number' ? usageSource.output_tokens : 0;
  const usageText = inputTokens || outputTokens ? `tokens in=${inputTokens} out=${outputTokens}` : '';

  return {
    success: true,
    result: content || usageText,
    accumulated: content,
    cost: 0,
    durationMs: 0,
    model: typeof usageSource?.model === 'string' ? usageSource.model : undefined,
    numTurns: 1,
    toolStats: {},
  };
}

function runCodex(options: AgentRunOptions, callbacks: AgentRunCallbacks): AgentRunHandle {
  const outputFile = join(tmpdir(), `cc-im-codex-${randomUUID()}.txt`);
  const args: string[] = [];

  if (!options.skipPermissions && options.codexApprovalPolicy) {
    args.push('-a', options.codexApprovalPolicy);
  }

  args.push('exec', '--json', '--skip-git-repo-check', '--output-last-message', outputFile);

  if (options.skipPermissions) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else if ((options.codexSandbox ?? 'workspace-write') === 'workspace-write') {
    args.push('--full-auto');
  } else {
    args.push('--sandbox', options.codexSandbox ?? 'read-only');
  }

  if (options.model) {
    args.push('--model', options.model);
  }

  // resume 不传 --cd：依赖 spawn cwd 与 session_meta.cwd 一致（findCodexSessions 已按 cwd 过滤会话列表）
  if (options.sessionId) {
    args.push('resume', options.sessionId, options.prompt);
  } else {
    args.push('--cd', options.workDir, options.prompt);
  }

  const env: Record<string, string | undefined> = { ...process.env };
  if (options.proxyUrl) {
    env.HTTPS_PROXY = options.proxyUrl;
    env.HTTP_PROXY = options.proxyUrl;
  }
  env.CC_IM_AGENT_PROVIDER = 'codex';
  env.CC_IM_HOOK_PORT = options.hookPort ? String(options.hookPort) : env.CC_IM_HOOK_PORT;
  env.CC_IM_CHAT_ID = options.chatId ?? env.CC_IM_CHAT_ID;
  env.CC_IM_THREAD_ROOT_MSG_ID = options.threadRootMsgId ?? env.CC_IM_THREAD_ROOT_MSG_ID;
  env.CC_IM_THREAD_ID = options.threadId ?? env.CC_IM_THREAD_ID;
  env.CC_IM_PLATFORM = options.platform ?? env.CC_IM_PLATFORM;
  if (options.skipPermissions) env.CC_IM_SKIP_PERMISSIONS = '1';

  const child = spawn(options.cliPath, args, {
    cwd: options.workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let accumulated = '';
  let accumulatedThinking = '';
  let completed = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let lastUsage: Record<string, unknown> | undefined;
  const toolStats: Record<string, number> = {};
  let sessionIdSent = false;

  const timeoutMs = options.timeoutMs && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 2_147_483_647)
    : 0;
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      if (!completed && !child.killed) {
        completed = true;
        child.kill('SIGTERM');
        callbacks.onError(`执行超时（${timeoutMs}ms），已终止进程`);
      }
    }, timeoutMs);
  }

  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    if (!sessionIdSent) {
      const sessionId = extractSessionId(event);
      const eventName = getEventName(event);
      if (sessionId && eventName.includes('thread')) {
        sessionIdSent = true;
        callbacks.onSessionId?.(sessionId);
      }
    }

    const tool = extractToolPayload(event);
    if (tool) {
      toolStats[tool.name] = (toolStats[tool.name] || 0) + 1;
      callbacks.onToolUse?.(tool.name, tool.input);
      return;
    }

    const item = (event.item && typeof event.item === 'object' ? event.item : undefined) as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === 'string' ? item.type : '';
    if (getEventName(event) === 'item.completed' && itemType === 'reasoning') {
      const thinking = extractText(item);
      if (thinking) {
        accumulatedThinking = accumulatedThinking ? `${accumulatedThinking}\n${thinking}` : thinking;
        callbacks.onThinking?.(accumulatedThinking);
      }
      return;
    }

    if (getEventName(event) === 'item.completed' && (itemType === 'agent_message' || itemType === 'message')) {
      const text = extractText(item);
      if (text) {
        accumulated = accumulated ? `${accumulated}\n${text}` : text;
        callbacks.onText(accumulated);
      }
      return;
    }

    if (getEventName(event) === 'turn.completed') {
      lastUsage = (event.usage && typeof event.usage === 'object' ? event.usage : undefined) as Record<string, unknown> | undefined;
      if (completed) return;
      completed = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);

      let finalContent = accumulated;
      try {
        const fileContent = readFileSync(outputFile, 'utf-8').trim();
        if (fileContent) finalContent = fileContent;
      } catch {}

      const result = buildResult(finalContent, lastUsage);
      result.toolStats = toolStats;
      callbacks.onComplete(result);
      return;
    }

    if (getEventName(event).endsWith('failed') || getEventName(event) === 'error') {
      if (completed) return;
      completed = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const errorText = extractText(event) || 'Codex 执行失败';
      callbacks.onError(errorText);
    }
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8192) stderr = stderr.slice(-8192);
  });

  const finalize = (exitCode: number | null = child.exitCode) => {
    if (!completed) {
      completed = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);

      let finalContent = accumulated;
      try {
        const fileContent = readFileSync(outputFile, 'utf-8').trim();
        if (fileContent) finalContent = fileContent;
      } catch {}

      if (exitCode && exitCode !== 0 && !finalContent) {
        callbacks.onError(stderr.trim() || `Codex CLI exited with code ${exitCode}`);
      } else {
        if (stderr.trim()) log.warn(`Codex emitted stderr: ${stderr.trim()}`);
        const result = buildResult(finalContent, lastUsage);
        result.toolStats = toolStats;
        callbacks.onComplete(result);
      }
    }
    try { unlinkSync(outputFile); } catch {}
  };

  child.on('close', (code) => finalize(code));
  child.on('error', (err) => {
    log.error(`Codex CLI error: ${err.message}`);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (!completed) {
      completed = true;
      callbacks.onError(`Failed to start Codex CLI: ${err.message}`);
    }
    try { unlinkSync(outputFile); } catch {}
  });
  rl.on('close', () => {
    if (child.exitCode !== null) finalize();
  });

  return {
    process: child as ChildProcess,
    abort: () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      rl.close();
      if (!child.killed) child.kill('SIGTERM');
      try { unlinkSync(outputFile); } catch {}
    },
  };
}

export const codexRuntime: AgentRuntime = {
  provider: 'codex',
  run: runCodex,
};
