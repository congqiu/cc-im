import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parseStreamLine, extractTextDelta, extractThinkingDelta, extractResult, type ParsedResult } from './stream-parser.js';
import { isStreamInit, isContentBlockStart, isContentBlockDelta, isContentBlockStop } from './types.js';

export interface ClaudeRunCallbacks {
  onText: (accumulated: string) => void;
  onThinking?: (accumulated: string) => void;
  onToolUse?: (toolName: string, toolInput?: Record<string, unknown>) => void;
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
  options?: { skipPermissions?: boolean; timeoutMs?: number; model?: string; chatId?: string; hookPort?: number; threadRootMsgId?: string; threadId?: string; platform?: string },
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
    env.CC_IM_CHAT_ID = options.chatId;
  }
  if (options?.hookPort) {
    env.CC_IM_HOOK_PORT = String(options.hookPort);
  }
  if (options?.threadRootMsgId) {
    env.CC_IM_THREAD_ROOT_MSG_ID = options.threadRootMsgId;
  }
  if (options?.threadId) {
    env.CC_IM_THREAD_ID = options.threadId;
  }
  if (options?.platform) {
    env.CC_IM_PLATFORM = options.platform;
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
  let toolStats: Record<string, number> = {};
  let timeoutHandle: NodeJS.Timeout | null = null;
  const pendingToolInputs = new Map<number, { name: string; json: string }>();

  // 设置超时
  if (options?.timeoutMs && options.timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      if (!completed && !child.killed) {
        completed = true;
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

    if (isContentBlockStart(event) && event.event.content_block.type === 'tool_use') {
      const { name } = event.event.content_block;
      if (name) pendingToolInputs.set(event.event.index, { name, json: '' });
      return;
    }

    if (isContentBlockDelta(event) && event.event.delta.type === 'input_json_delta') {
      const pending = pendingToolInputs.get(event.event.index);
      if (pending) pending.json += event.event.delta.partial_json ?? '';
      return;
    }

    if (isContentBlockStop(event)) {
      const pending = pendingToolInputs.get(event.event.index);
      if (pending) {
        toolStats[pending.name] = (toolStats[pending.name] || 0) + 1;
        let input: Record<string, unknown> | undefined;
        try { input = JSON.parse(pending.json); } catch { /* empty input */ }
        callbacks.onToolUse?.(pending.name, input);
        pendingToolInputs.delete(event.event.index);
      }
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
      result.toolStats = toolStats;
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
  let rlClosed = false;
  let childClosed = false;

  const finalize = () => {
    if (!rlClosed || !childClosed) return;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (!completed) {
      if (exitCode !== null && exitCode !== 0) {
        // 组合首尾 stderr 信息
        let stderrData = '';
        if (!headFull) {
          // head 未满，stderrHead 包含全部内容
          stderrData = stderrHead;
        } else if (stderrTotal <= MAX_HEAD_LEN + MAX_TAIL_LEN) {
          // head 已满但总量未超限，去掉 tail 中与 head 重叠的部分
          stderrData = stderrHead + stderrTail.slice(stderrTail.length - (stderrTotal - MAX_HEAD_LEN));
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
          numTurns: 0,
          toolStats,
        });
      }
    }
  };

  child.on('close', (code) => {
    exitCode = code;
    childClosed = true;
    finalize();
  });

  // 使用 rl 的 close 事件而非 child 的 close，确保所有行都处理完毕
  rl.on('close', () => {
    rlClosed = true;
    finalize();
  });

  child.on('error', (err) => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (!completed) {
      completed = true;
      callbacks.onError(`Failed to start Claude CLI: ${err.message}`);
    }
    // spawn 失败时可能不触发 close 事件，手动标记以确保 finalize 执行
    childClosed = true;
    finalize();
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
