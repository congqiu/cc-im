import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseStreamLine, extractTextDelta, extractThinkingDelta, extractResult, type ParsedResult } from './stream-parser.js';
import { isStreamInit } from './types.js';

export interface ClaudeRunCallbacks {
  onText: (accumulated: string) => void;
  onThinking?: (accumulated: string) => void;
  onComplete: (result: ParsedResult) => void;
  onError: (error: string) => void;
  onSessionId?: (sessionId: string) => void;
}

export interface ClaudeRunHandle {
  process: ChildProcess;
  abort: () => void;
}

export function runClaude(
  cliPath: string,
  prompt: string,
  sessionId: string | undefined,
  workDir: string,
  callbacks: ClaudeRunCallbacks,
  options?: { skipPermissions?: boolean; timeoutMs?: number; model?: string; chatId?: string; hookPort?: number },
): ClaudeRunHandle {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (options?.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options?.model) {
    args.push('--model', options.model);
  }

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  args.push('--', prompt);

  const env: Record<string, string | undefined> = { ...process.env };
  if (options?.chatId) {
    env.CC_BOT_CHAT_ID = options.chatId;
  }
  if (options?.hookPort) {
    env.CC_BOT_HOOK_PORT = String(options.hookPort);
  }

  const child = spawn(cliPath, args, {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let accumulated = '';
  let accumulatedThinking = '';
  let completed = false;
  let model = '';
  let timeoutHandle: NodeJS.Timeout | null = null;

  // 设置超时
  if (options?.timeoutMs && options.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      if (!completed && !child.killed) {
        child.kill('SIGTERM');
        callbacks.onError(`执行超时（${options.timeoutMs}ms），已终止进程`);
      }
    }, options.timeoutMs);
  }

  const rl = createInterface({ input: child.stdout! });

  rl.on('line', (line) => {
    const event = parseStreamLine(line);
    if (!event) return;

    if (isStreamInit(event)) {
      model = event.model;
      callbacks.onSessionId?.(event.session_id);
    }

    const delta = extractTextDelta(event);
    if (delta) {
      accumulated += delta.text;
      callbacks.onText(accumulated);
      return;
    }

    const thinking = extractThinkingDelta(event);
    if (thinking) {
      accumulatedThinking += thinking.text;
      callbacks.onThinking?.(accumulatedThinking);
      return;
    }

    const result = extractResult(event);
    if (result) {
      completed = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      result.accumulated = accumulated;
      result.model = model;
      if (!accumulated && result.result) {
        accumulated = result.result;
      }
      callbacks.onComplete(result);
    }
  });

  // 保留首部和尾部的 stderr，避免丢失关键错误信息
  const MAX_HEAD_LEN = 4 * 1024; // 保留前 4KB
  const MAX_TAIL_LEN = 6 * 1024; // 保留后 6KB
  let stderrHead = '';
  let stderrTail = '';
  let stderrTotal = 0;
  let headFull = false;

  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    stderrTotal += text.length;

    if (!headFull) {
      const headRoom = MAX_HEAD_LEN - stderrHead.length;
      if (headRoom > 0) {
        stderrHead += text.slice(0, headRoom);
        if (stderrHead.length >= MAX_HEAD_LEN) {
          headFull = true;
        }
      }
    }

    stderrTail += text;
    if (stderrTail.length > MAX_TAIL_LEN) {
      stderrTail = stderrTail.slice(-MAX_TAIL_LEN);
    }
  });

  let exitCode: number | null = null;
  child.on('close', (code) => {
    exitCode = code;
  });

  // 使用 rl 的 close 事件而非 child 的 close，确保所有行都处理完毕
  rl.on('close', () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (!completed) {
      if (exitCode !== null && exitCode !== 0) {
        // 组合首尾 stderr 信息
        let stderrData = '';
        if (stderrTotal <= MAX_HEAD_LEN + MAX_TAIL_LEN) {
          // 内容未超限，直接使用
          stderrData = stderrHead + (headFull ? stderrTail : '');
        } else {
          // 内容超限，显示首尾部分
          stderrData = stderrHead + `\n\n... (省略 ${stderrTotal - MAX_HEAD_LEN - MAX_TAIL_LEN} 字节) ...\n\n` + stderrTail;
        }
        callbacks.onError(stderrData || `Claude CLI exited with code ${exitCode}`);
      } else {
        // Completed without a result event — treat accumulated text as result
        callbacks.onComplete({
          success: true,
          result: accumulated,
          accumulated,
          cost: 0,
          durationMs: 0,
          model,
        });
      }
    }
  });

  child.on('error', (err) => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (!completed) {
      callbacks.onError(`Failed to start Claude CLI: ${err.message}`);
    }
  });

  return {
    process: child,
    abort: () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    },
  };
}
