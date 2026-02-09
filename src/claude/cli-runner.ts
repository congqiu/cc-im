import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseStreamLine, extractTextDelta, extractResult, type ParsedResult } from './stream-parser.js';

export interface ClaudeRunCallbacks {
  onText: (accumulated: string) => void;
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
): ClaudeRunHandle {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
  ];

  if (sessionId) {
    args.push('--session-id', sessionId);
  }

  args.push(prompt);

  const child = spawn(cliPath, args, {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let accumulated = '';
  let completed = false;

  const rl = createInterface({ input: child.stdout! });

  rl.on('line', (line) => {
    const event = parseStreamLine(line);
    if (!event) return;

    if (event.type === 'system' && (event as any).subtype === 'init' && (event as any).session_id) {
      callbacks.onSessionId?.((event as any).session_id);
    }

    const delta = extractTextDelta(event);
    if (delta) {
      accumulated += delta.text;
      callbacks.onText(accumulated);
      return;
    }

    const result = extractResult(event);
    if (result) {
      completed = true;
      // Use the result text if we haven't accumulated anything
      if (!accumulated && result.result) {
        accumulated = result.result;
      }
      callbacks.onComplete(result);
    }
  });

  let stderrData = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrData += chunk.toString();
  });

  child.on('close', (code) => {
    if (!completed) {
      if (code !== 0) {
        callbacks.onError(stderrData || `Claude CLI exited with code ${code}`);
      } else {
        // Completed without a result event — treat accumulated text as result
        callbacks.onComplete({
          success: true,
          result: accumulated,
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
