import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Import after mocks
import { runClaude } from '../../../src/claude/cli-runner.js';
import * as cp from 'node:child_process';

const mockSpawn = vi.mocked(cp.spawn);

describe('CLI Runner', () => {
  let mockChild: any;
  let mockStdout: Readable;
  let mockStderr: Readable;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Create mock child process
    mockChild = new EventEmitter();
    mockStdout = new Readable({ read() {} });
    mockStderr = new Readable({ read() {} });

    mockChild.stdout = mockStdout;
    mockChild.stderr = mockStderr;
    mockChild.killed = false;
    mockChild.kill = vi.fn((signal) => {
      mockChild.killed = true;
      mockChild.emit('close', null);
      return true;
    });

    mockSpawn.mockReturnValue(mockChild);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('应该构建正确的 CLI 参数', () => {
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runClaude('/path/to/claude', 'test prompt', undefined, '/work', callbacks);

    expect(mockSpawn).toHaveBeenCalledWith(
      '/path/to/claude',
      expect.arrayContaining([
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--', 'test prompt',
      ]),
      expect.objectContaining({
        cwd: '/work',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
  });

  it('有 sessionId 时应该添加 --resume', () => {
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', 'session-123', '/work', callbacks);

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--resume');
    expect(args).toContain('session-123');
  });

  it('skipPermissions 时应该添加 flag', () => {
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks, {
      skipPermissions: true,
    });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('指定 model 时应该添加 --model', () => {
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks, {
      model: 'opus',
    });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--model');
    expect(args).toContain('opus');
  });

  it.each([
    { option: 'chatId', value: 'chat-123', envKey: 'CC_IM_CHAT_ID', envValue: 'chat-123' },
    { option: 'hookPort', value: 18900, envKey: 'CC_IM_HOOK_PORT', envValue: '18900' },
    { option: 'threadRootMsgId', value: 'om-root-123', envKey: 'CC_IM_THREAD_ROOT_MSG_ID', envValue: 'om-root-123' },
    { option: 'threadId', value: 'omt-thread-456', envKey: 'CC_IM_THREAD_ID', envValue: 'omt-thread-456' },
    { option: 'platform', value: 'feishu', envKey: 'CC_IM_PLATFORM', envValue: 'feishu' },
  ])('传入 $option 时应该设置 $envKey 环境变量', ({ option, value, envKey, envValue }) => {
    const callbacks = { onText: vi.fn(), onComplete: vi.fn(), onError: vi.fn() };
    runClaude('/claude', 'prompt', undefined, '/work', callbacks, { [option]: value });
    const env = mockSpawn.mock.calls[0][2].env;
    expect(env[envKey]).toBe(envValue);
  });

  it('收到 init 事件应该回调 onSessionId', async () => {
    const onSessionId = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      onSessionId,
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks);

    // Emit init event
    const initEvent = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'new-session-123',
      tools: [],
      mcp_servers: [],
      model: 'claude-opus-4',
    });

    mockStdout.push(initEvent + '\n');

    // Wait for event processing
    await vi.waitFor(() => {
      expect(onSessionId).toHaveBeenCalledWith('new-session-123');
    });
  });

  it('收到 text_delta 应该回调 onText 累积', async () => {
    const onText = vi.fn();
    const callbacks = {
      onText,
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks);

    const delta1 = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    });

    const delta2 = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ', world' },
      },
    });

    mockStdout.push(delta1 + '\n');
    mockStdout.push(delta2 + '\n');

    await vi.waitFor(() => {
      expect(onText).toHaveBeenCalledTimes(2);
      expect(onText).toHaveBeenNthCalledWith(1, 'Hello');
      expect(onText).toHaveBeenNthCalledWith(2, 'Hello, world');
    });
  });

  it('收到 thinking_delta 应该回调 onThinking', async () => {
    const onThinking = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onThinking,
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks);

    const thinkingEvent = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Thinking...' },
      },
    });

    mockStdout.push(thinkingEvent + '\n');

    await vi.waitFor(() => {
      expect(onThinking).toHaveBeenCalledWith('Thinking...');
    });
  });

  it('收到 result 事件应该回调 onComplete', async () => {
    const onComplete = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onComplete,
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks);

    const resultEvent = JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Task completed',
      session_id: 'test-123',
      total_cost_usd: 0.05,
      duration_ms: 2000,
      duration_api_ms: 1500,
      num_turns: 2,
    });

    mockStdout.push(resultEvent + '\n');
    mockStdout.push(null); // End stream

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
      const result = onComplete.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.cost).toBe(0.05);
      expect(result.durationMs).toBe(2000);
    });
  });

  it('进程非零退码应该回调 onError', async () => {
    const onError = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError,
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks);

    mockStderr.push('Some error\n');
    mockStderr.push(null);
    mockStdout.push(null);

    // Simulate process exit
    mockChild.emit('close', 1);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
      const error = onError.mock.calls[0][0];
      expect(error).toContain('Some error');
    });
  });

  it('进程启动失败应该回调 onError', async () => {
    const onError = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError,
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks, {
      timeoutMs: 5000, // 添加timeout以测试error时的clearTimeout
    });

    mockChild.emit('error', new Error('ENOENT'));

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
      const error = onError.mock.calls[0][0];
      expect(error).toContain('Failed to start');
    });
  });

  it('超时应该终止进程', () => {
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks, {
      timeoutMs: 5000,
    });

    expect(mockChild.kill).not.toHaveBeenCalled();

    // Fast-forward time
    vi.advanceTimersByTime(5000);

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.stringContaining('执行超时')
    );
  });

  it('abort() 应该发送 SIGTERM', () => {
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError: vi.fn(),
    };

    const handle = runClaude('/claude', 'prompt', undefined, '/work', callbacks, {
      timeoutMs: 10000, // 设置超时，让abort有timeout要清理
    });

    expect(mockChild.kill).not.toHaveBeenCalled();

    handle.abort();

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stderr 内容应该被捕获', async () => {
    const onError = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onComplete: vi.fn(),
      onError,
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks);

    // 生成 stderr
    mockStderr.push('Error occurred\n');
    mockStderr.push(null);
    mockStdout.push(null);

    mockChild.emit('close', 1);

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalled();
      const error = onError.mock.calls[0][0];
      expect(error).toContain('Error occurred');
    });
  });

  it('无 result 但正常退出应该用 accumulated 作为 result', async () => {
    const onComplete = vi.fn();
    const callbacks = {
      onText: vi.fn(),
      onComplete,
      onError: vi.fn(),
    };

    runClaude('/claude', 'prompt', undefined, '/work', callbacks);

    // Send text delta
    const delta = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Some text' },
      },
    });

    mockStdout.push(delta + '\n');
    mockStdout.push(null); // End without result event

    mockChild.emit('close', 0);

    await vi.waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
      const result = onComplete.mock.calls[0][0];
      expect(result.success).toBe(true);
      expect(result.accumulated).toBe('Some text');
    });
  });
});
