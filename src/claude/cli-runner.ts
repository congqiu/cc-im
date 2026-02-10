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
  options?: { skipPermissions?: boolean },
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

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  args.push('--', prompt);

  const child = spawn(cliPath, args, {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let accumulated = '';
  let accumulatedThinking = '';
  let completed = false;

  const rl = createInterface({ input: child.stdout! });

  rl.on('line', (line) => {
    const event = parseStreamLine(line);
    if (!event) return;

    if (isStreamInit(event)) {
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
      result.accumulated = accumulated;
      if (!accumulated && result.result) {
        accumulated = result.result;
      }
      callbacks.onComplete(result);
    }
  });

  const MAX_STDERR_LEN = 10 * 1024; // 保留最后 10KB
  let stderrData = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrData += chunk.toString();
    if (stderrData.length > MAX_STDERR_LEN) {
      stderrData = stderrData.slice(-MAX_STDERR_LEN);
    }
  });

  let exitCode: number | null = null;
  child.on('close', (code) => {
    exitCode = code;
  });

  // 使用 rl 的 close 事件而非 child 的 close，确保所有行都处理完毕
  rl.on('close', () => {
    if (!completed) {
      if (exitCode !== null && exitCode !== 0) {
        callbacks.onError(stderrData || `Claude CLI exited with code ${exitCode}`);
      } else {
        // Completed without a result event — treat accumulated text as result
        callbacks.onComplete({
          success: true,
          result: accumulated,
          accumulated,
          cost: 0,
          durationMs: 0,
        });
      }
    }
  });

  child.on('error', (err) => {
    if (!completed) {
      callbacks.onError(`Failed to start Claude CLI: ${err.message}`);
    }
  });

  return {
    process: child,
    abort: () => {
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    },
  };
}
