import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClaudeRunCallbacks } from '../../../src/claude/cli-runner.js';
import type { ParsedResult } from '../../../src/claude/stream-parser.js';
import type { TaskAdapter, TaskContext, TaskDeps, TaskRunState } from '../../../src/shared/claude-task.js';
import type { CostRecord } from '../../../src/shared/types.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockAccess = vi.fn();
vi.mock('node:fs/promises', () => ({
  access: (...args: any[]) => mockAccess(...args),
}));

// Capture callbacks passed to runClaude so tests can invoke them
let capturedCallbacks: ClaudeRunCallbacks;
let capturedOptions: any;
const mockAbort = vi.fn();

vi.mock('../../../src/claude/cli-runner.js', () => ({
  runClaude: vi.fn((_cliPath: string, _prompt: string, _sessionId: string | undefined, _workDir: string, callbacks: ClaudeRunCallbacks, options?: any) => {
    capturedCallbacks = callbacks;
    capturedOptions = options;
    return { process: { kill: vi.fn() }, abort: mockAbort };
  }),
}));

// Import after mocks
import { runClaudeTask } from '../../../src/shared/claude-task.js';
import { runClaude } from '../../../src/claude/cli-runner.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<any>) {
  return {
    claudeCliPath: '/usr/bin/claude',
    claudeSkipPermissions: false,
    claudeTimeoutMs: 300000,
    claudeModel: 'sonnet',
    hookPort: 18900,
    ...overrides,
  };
}

function makeSessionManager(overrides?: Record<string, any>) {
  return {
    getSessionIdForConv: vi.fn(),
    setSessionIdForConv: vi.fn(),
    getSessionIdForThread: vi.fn(),
    setSessionIdForThread: vi.fn(),
    addTurns: vi.fn(() => 3),
    addTurnsForThread: vi.fn(() => 3),
    getModel: vi.fn(() => undefined),
    ...overrides,
  } as any;
}

function makeDeps(overrides?: { config?: any; sessionManager?: any; userCosts?: Map<string, CostRecord> }): TaskDeps {
  return {
    config: overrides?.config ?? makeConfig(),
    sessionManager: overrides?.sessionManager ?? makeSessionManager(),
    userCosts: overrides?.userCosts ?? new Map<string, CostRecord>(),
  };
}

function makeCtx(overrides?: Partial<TaskContext>): TaskContext {
  return {
    userId: 'user-1',
    chatId: 'chat-1',
    workDir: '/work',
    sessionId: undefined,
    convId: 'conv-1',
    platform: 'feishu',
    taskKey: 'user-1:conv-1',
    ...overrides,
  };
}

function makeAdapter(overrides?: Partial<TaskAdapter>): TaskAdapter {
  return {
    streamUpdate: vi.fn(),
    sendComplete: vi.fn().mockResolvedValue(undefined),
    sendError: vi.fn().mockResolvedValue(undefined),
    onThinkingToText: vi.fn(),
    extraCleanup: vi.fn(),
    throttleMs: 80,
    onTaskReady: vi.fn(),
    ...overrides,
  };
}

function makeResult(overrides?: Partial<ParsedResult>): ParsedResult {
  return {
    success: true,
    result: 'done',
    accumulated: 'Hello world',
    cost: 0.05,
    durationMs: 2000,
    model: 'claude-sonnet',
    numTurns: 2,
    toolStats: {},
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('runClaudeTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 1. Successful completion ──────────────────────────────────────────────

  describe('成功完成', () => {
    it('应该调用 adapter.sendComplete 并传入内容和 note', async () => {
      const adapter = makeAdapter();
      const ctx = makeCtx();

      const promise = runClaudeTask(makeDeps(), ctx, 'hello', adapter);

      // Simulate completion
      const result = makeResult();
      await capturedCallbacks.onComplete!(result);

      await promise;

      expect(adapter.sendComplete).toHaveBeenCalledWith(
        'Hello world',
        expect.stringContaining('$0.0500'),
        undefined,
      );
    });

    it('无输出时应该使用 "(无输出)" 作为内容', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult({ accumulated: '', result: '' }));
      await promise;

      expect(adapter.sendComplete).toHaveBeenCalledWith(
        '(无输出)',
        expect.any(String),
        undefined,
      );
    });

    it('cost 为 0 时 note 应该显示"完成"', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult({ cost: 0, durationMs: 0 }));
      await promise;

      expect(adapter.sendComplete).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('完成'),
        undefined,
      );
    });

    it('sendComplete 失败不应该抛出异常', async () => {
      const adapter = makeAdapter({
        sendComplete: vi.fn().mockRejectedValue(new Error('network error')),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult());

      // Should resolve without throwing
      await expect(promise).resolves.toBeUndefined();
    });

    it('应该传递 thinkingText 给 sendComplete', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // Simulate thinking then completion
      capturedCallbacks.onThinking!('Let me think...');
      await capturedCallbacks.onComplete!(makeResult());

      await promise;

      expect(adapter.sendComplete).toHaveBeenCalledWith(
        'Hello world',
        expect.any(String),
        'Let me think...',
      );
    });
  });

  // ── 2. Error handling ─────────────────────────────────────────────────────

  describe('错误处理', () => {
    it('应该调用 adapter.sendError', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onError!('Something went wrong');
      await promise;

      expect(adapter.sendError).toHaveBeenCalledWith('Something went wrong');
    });

    it('sendError 失败不应该抛出异常', async () => {
      const adapter = makeAdapter({
        sendError: vi.fn().mockRejectedValue(new Error('network error')),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onError!('Something went wrong');

      await expect(promise).resolves.toBeUndefined();
    });
  });

  // ── 3. Session ID management ──────────────────────────────────────────────

  describe('Session ID 管理', () => {
    it('有 convId 时应该通过 setSessionIdForConv 保存 session', async () => {
      const sm = makeSessionManager();
      const ctx = makeCtx({ convId: 'conv-42' });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ sessionManager: sm }), ctx, 'hello', adapter,
      );

      capturedCallbacks.onSessionId!('session-abc');

      // Complete to resolve the promise
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sm.setSessionIdForConv).toHaveBeenCalledWith('user-1', 'conv-42', 'session-abc');
    });

    it('有 threadId 时应该通过 setSessionIdForThread 保存 session', async () => {
      const sm = makeSessionManager();
      const ctx = makeCtx({ threadId: 'thread-1', convId: 'conv-1' });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ sessionManager: sm }), ctx, 'hello', adapter,
      );

      capturedCallbacks.onSessionId!('session-xyz');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sm.setSessionIdForThread).toHaveBeenCalledWith('user-1', 'thread-1', 'session-xyz');
      // Should not call setSessionIdForConv when threadId is present
      expect(sm.setSessionIdForConv).not.toHaveBeenCalled();
    });

    it('既无 threadId 也无 convId 时不应该保存 session', async () => {
      const sm = makeSessionManager();
      const ctx = makeCtx({ convId: undefined, threadId: undefined });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ sessionManager: sm }), ctx, 'hello', adapter,
      );

      capturedCallbacks.onSessionId!('session-noop');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sm.setSessionIdForConv).not.toHaveBeenCalled();
      expect(sm.setSessionIdForThread).not.toHaveBeenCalled();
    });
  });

  // ── 4. Throttled updates ──────────────────────────────────────────────────

  describe('节流更新', () => {
    it('首次调用应该立即发送', async () => {
      const adapter = makeAdapter({ throttleMs: 100 });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onText!('Hello');

      expect(adapter.streamUpdate).toHaveBeenCalledTimes(1);
      expect(adapter.streamUpdate).toHaveBeenCalledWith('Hello', undefined);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('节流间隔内的第二次调用应该延迟', async () => {
      const adapter = makeAdapter({ throttleMs: 100 });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // First call - immediate
      capturedCallbacks.onText!('Hello');
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(1);

      // Second call within throttle window - should be deferred
      vi.advanceTimersByTime(50);
      capturedCallbacks.onText!('Hello World');
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(1);

      // After throttle period, deferred update fires
      vi.advanceTimersByTime(60);
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(2);
      expect(adapter.streamUpdate).toHaveBeenLastCalledWith('Hello World', undefined);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('节流间隔后的调用应该立即发送', async () => {
      const adapter = makeAdapter({ throttleMs: 100 });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onText!('A');
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(1);

      // Wait beyond throttle interval
      vi.advanceTimersByTime(150);

      capturedCallbacks.onText!('AB');
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(2);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });
  });

  // ── 5. Thinking mode ──────────────────────────────────────────────────────

  describe('思考模式', () => {
    it('思考内容应该带有 💭 前缀', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onThinking!('Analyzing the problem');

      expect(adapter.streamUpdate).toHaveBeenCalledWith(
        '💭 **思考中...**\n\nAnalyzing the problem',
        undefined,
      );

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('从思考切换到文本时应该调用 onThinkingToText', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // First thinking
      capturedCallbacks.onThinking!('Let me think');

      // Then text - should trigger onThinkingToText
      capturedCallbacks.onText!('Here is the answer');

      expect(adapter.onThinkingToText).toHaveBeenCalledWith('Here is the answer');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('切换到文本时应该清除 pending update 并更新 latestContent', async () => {
      let taskState: TaskRunState | undefined;
      const adapter = makeAdapter({
        throttleMs: 100,
        onTaskReady: vi.fn((state: TaskRunState) => { taskState = state; }),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // Trigger thinking (immediate)
      capturedCallbacks.onThinking!('Thinking...');
      // Another thinking within throttle - schedules pending update
      vi.advanceTimersByTime(50);
      capturedCallbacks.onThinking!('Still thinking...');

      // Transition to text - should clear pending and update latestContent
      capturedCallbacks.onText!('The answer');

      expect(taskState!.latestContent).toBe('The answer');
      expect(adapter.onThinkingToText).toHaveBeenCalledWith('The answer');

      // The pending timer should have been cleared and not fire
      vi.advanceTimersByTime(200);
      // streamUpdate should have been called twice (first thinking immediate, then no pending fire)
      // first onThinking immediate + no pending after transition
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(1);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('没有 onThinkingToText 回调时直接走 throttledUpdate', async () => {
      const adapter = makeAdapter({ throttleMs: 100, onThinkingToText: undefined });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onThinking!('Thinking');
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(1);

      // Advance past throttle window so the next call goes through immediately
      vi.advanceTimersByTime(150);
      capturedCallbacks.onText!('Answer');

      // Without onThinkingToText, should fall through to throttledUpdate
      expect(adapter.streamUpdate).toHaveBeenCalledTimes(2);
      expect(adapter.streamUpdate).toHaveBeenLastCalledWith('Answer', undefined);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });
  });

  // ── 6. Tool use tracking ──────────────────────────────────────────────────

  describe('工具使用追踪', () => {
    it('工具调用应该触发带有工具通知的更新', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // Send initial text first
      capturedCallbacks.onText!('Working on it');
      vi.clearAllMocks();

      // Then tool use
      vi.advanceTimersByTime(100);
      capturedCallbacks.onToolUse!('Bash', { command: 'ls -la' });

      expect(adapter.streamUpdate).toHaveBeenCalledWith(
        'Working on it',
        expect.stringContaining('Bash'),
      );

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('工具统计应该出现在完成 note 中', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult({
        toolStats: { Read: 3, Bash: 2 },
        numTurns: 2,
      }));
      await promise;

      const note = (adapter.sendComplete as any).mock.calls[0][1] as string;
      expect(note).toContain('Read');
      expect(note).toContain('Bash');
      expect(note).toContain('5 次工具');
    });

    it('超过 5 条工具记录只保留最近 5 条', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // First text to set latestContent
      capturedCallbacks.onText!('content');
      vi.advanceTimersByTime(100);
      vi.clearAllMocks();

      // Add 7 tool calls
      for (let i = 1; i <= 7; i++) {
        vi.advanceTimersByTime(100);
        capturedCallbacks.onToolUse!('Bash', { command: `cmd${i}` });
      }

      // The last streamUpdate should only have 3 recent tool lines (slice(-3))
      const lastCall = (adapter.streamUpdate as any).mock.calls.at(-1);
      const toolNote = lastCall[1] as string;
      const lines = toolNote.split('\n');
      expect(lines.length).toBe(3);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });
  });

  // ── 7. Cost tracking ──────────────────────────────────────────────────────

  describe('费用追踪', () => {
    it('完成时应该更新 userCosts map', async () => {
      const adapter = makeAdapter();
      const userCosts = new Map<string, CostRecord>();

      const promise = runClaudeTask(
        makeDeps({ userCosts }), makeCtx(), 'hello', adapter,
      );

      await capturedCallbacks.onComplete!(makeResult({ cost: 0.123, durationMs: 5000 }));
      await promise;

      const record = userCosts.get('user-1');
      expect(record).toBeDefined();
      expect(record!.totalCost).toBeCloseTo(0.123);
      expect(record!.totalDurationMs).toBe(5000);
      expect(record!.requestCount).toBe(1);
    });

    it('多次完成应该累加费用', async () => {
      const adapter = makeAdapter();
      const userCosts = new Map<string, CostRecord>();
      const deps = makeDeps({ userCosts });

      // First task
      const p1 = runClaudeTask(deps, makeCtx(), 'hello1', adapter);
      await capturedCallbacks.onComplete!(makeResult({ cost: 0.1, durationMs: 1000 }));
      await p1;

      // Second task
      const p2 = runClaudeTask(deps, makeCtx(), 'hello2', adapter);
      await capturedCallbacks.onComplete!(makeResult({ cost: 0.2, durationMs: 2000 }));
      await p2;

      const record = userCosts.get('user-1')!;
      expect(record.totalCost).toBeCloseTo(0.3);
      expect(record.totalDurationMs).toBe(3000);
      expect(record.requestCount).toBe(2);
    });
  });

  // ── 8. Turn tracking ─────────────────────────────────────────────────────

  describe('轮次追踪', () => {
    it('非话题任务应该调用 addTurns', async () => {
      const sm = makeSessionManager({ addTurns: vi.fn(() => 5) });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ sessionManager: sm }), makeCtx({ threadId: undefined }),
        'hello', adapter,
      );

      await capturedCallbacks.onComplete!(makeResult({ numTurns: 3 }));
      await promise;

      expect(sm.addTurns).toHaveBeenCalledWith('user-1', 3);
    });

    it('话题任务应该调用 addTurnsForThread', async () => {
      const sm = makeSessionManager({ addTurnsForThread: vi.fn(() => 7) });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ sessionManager: sm }), makeCtx({ threadId: 'thread-42' }),
        'hello', adapter,
      );

      await capturedCallbacks.onComplete!(makeResult({ numTurns: 4 }));
      await promise;

      expect(sm.addTurnsForThread).toHaveBeenCalledWith('user-1', 'thread-42', 4);
    });

    it('累计轮次 >= 8 时 note 中应该包含上下文提示', async () => {
      const sm = makeSessionManager({ addTurns: vi.fn(() => 9) });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ sessionManager: sm }), makeCtx(), 'hello', adapter,
      );

      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      const note = (adapter.sendComplete as any).mock.calls[0][1] as string;
      expect(note).toContain('/compact');
    });

    it('累计轮次 >= 12 时 note 中应该包含强警告', async () => {
      const sm = makeSessionManager({ addTurns: vi.fn(() => 15) });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ sessionManager: sm }), makeCtx(), 'hello', adapter,
      );

      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      const note = (adapter.sendComplete as any).mock.calls[0][1] as string;
      expect(note).toContain('/new');
    });
  });

  // ── 9. Settled state ──────────────────────────────────────────────────────

  describe('Settled 状态', () => {
    it('settle 后 onComplete 应该是 no-op', async () => {
      let taskState: TaskRunState | undefined;
      const adapter = makeAdapter({
        onTaskReady: vi.fn((state: TaskRunState) => { taskState = state; }),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // Call settle manually
      taskState!.settle();

      // Now onComplete should be a no-op
      await capturedCallbacks.onComplete!(makeResult());

      await promise;

      expect(adapter.sendComplete).not.toHaveBeenCalled();
    });

    it('settle 后 onError 应该是 no-op', async () => {
      let taskState: TaskRunState | undefined;
      const adapter = makeAdapter({
        onTaskReady: vi.fn((state: TaskRunState) => { taskState = state; }),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      taskState!.settle();

      await capturedCallbacks.onError!('error after settle');

      await promise;

      expect(adapter.sendError).not.toHaveBeenCalled();
    });

    it('重复调用 settle 不应该报错', async () => {
      let taskState: TaskRunState | undefined;
      const adapter = makeAdapter({
        onTaskReady: vi.fn((state: TaskRunState) => { taskState = state; }),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      taskState!.settle();
      taskState!.settle(); // Should not throw

      await promise;

      expect(adapter.extraCleanup).toHaveBeenCalledTimes(1);
    });
  });

  // ── 10. onTaskReady callback ──────────────────────────────────────────────

  describe('onTaskReady 回调', () => {
    it('应该接收包含 handle、latestContent、settle、startedAt 的 TaskRunState', async () => {
      let taskState: TaskRunState | undefined;
      const adapter = makeAdapter({
        onTaskReady: vi.fn((state: TaskRunState) => { taskState = state; }),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      expect(adapter.onTaskReady).toHaveBeenCalledTimes(1);
      expect(taskState).toBeDefined();
      expect(taskState!.handle).toBeDefined();
      expect(taskState!.handle.abort).toBe(mockAbort);
      expect(taskState!.latestContent).toBe('');
      expect(typeof taskState!.settle).toBe('function');
      expect(typeof taskState!.startedAt).toBe('number');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('latestContent 应该在流式更新中持续更新', async () => {
      let taskState: TaskRunState | undefined;
      const adapter = makeAdapter({
        onTaskReady: vi.fn((state: TaskRunState) => { taskState = state; }),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onText!('Hello');
      expect(taskState!.latestContent).toBe('Hello');

      vi.advanceTimersByTime(100);
      capturedCallbacks.onText!('Hello World');
      expect(taskState!.latestContent).toBe('Hello World');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });
  });

  // ── 11. onFirstContent callback ───────────────────────────────────────────

  describe('onFirstContent 回调', () => {
    it('首次收到文本内容时应该调用 onFirstContent', async () => {
      const onFirstContent = vi.fn();
      const adapter = makeAdapter({ onFirstContent });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onText!('Hello');

      expect(onFirstContent).toHaveBeenCalledTimes(1);

      // Second call should not trigger again
      vi.advanceTimersByTime(100);
      capturedCallbacks.onText!('Hello World');
      expect(onFirstContent).toHaveBeenCalledTimes(1);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('首次收到思考内容时也应该调用 onFirstContent', async () => {
      const onFirstContent = vi.fn();
      const adapter = makeAdapter({ onFirstContent });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onThinking!('Let me think');

      expect(onFirstContent).toHaveBeenCalledTimes(1);

      // Subsequent text should not trigger again
      capturedCallbacks.onText!('Answer');
      expect(onFirstContent).toHaveBeenCalledTimes(1);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('不提供 onFirstContent 不应该报错', async () => {
      const adapter = makeAdapter({ onFirstContent: undefined });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // Should not throw
      capturedCallbacks.onText!('Hello');
      capturedCallbacks.onThinking!('Thinking');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });
  });

  // ── 12. extraCleanup ──────────────────────────────────────────────────────

  describe('extraCleanup', () => {
    it('完成时应该调用 extraCleanup', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(adapter.extraCleanup).toHaveBeenCalledTimes(1);
    });

    it('错误时应该调用 extraCleanup', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onError!('boom');
      await promise;

      expect(adapter.extraCleanup).toHaveBeenCalledTimes(1);
    });

    it('settle 时应该调用 extraCleanup', async () => {
      let taskState: TaskRunState | undefined;
      const adapter = makeAdapter({
        onTaskReady: vi.fn((state: TaskRunState) => { taskState = state; }),
      });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      taskState!.settle();
      await promise;

      expect(adapter.extraCleanup).toHaveBeenCalledTimes(1);
    });

    it('没有 extraCleanup 也不应该报错', async () => {
      const adapter = makeAdapter({ extraCleanup: undefined });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult());

      await expect(promise).resolves.toBeUndefined();
    });
  });

  // ── 13. runClaude 参数传递 ────────────────────────────────────────────────

  describe('runClaude 参数传递', () => {
    it('应该传递正确的 CLI 路径、prompt 和工作目录', async () => {
      const adapter = makeAdapter();
      const ctx = makeCtx({ sessionId: 'sess-1', workDir: '/my/project' });

      const promise = runClaudeTask(
        makeDeps({ config: makeConfig({ claudeCliPath: '/custom/claude' }) }),
        ctx, 'write code', adapter,
      );

      expect(runClaude).toHaveBeenCalledWith(
        '/custom/claude',
        'write code',
        'sess-1',
        '/my/project',
        expect.any(Object),
        expect.objectContaining({
          skipPermissions: false,
          timeoutMs: 300000,
          chatId: 'chat-1',
          hookPort: 18900,
          platform: 'feishu',
        }),
      );

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('用户设置的模型应该优先于默认模型', async () => {
      const sm = makeSessionManager({ getModel: vi.fn(() => 'opus') });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ config: makeConfig({ claudeModel: 'sonnet' }), sessionManager: sm }),
        makeCtx(), 'hello', adapter,
      );

      expect(capturedOptions.model).toBe('opus');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('用户未设置模型时应该使用配置默认模型', async () => {
      const sm = makeSessionManager({ getModel: vi.fn(() => undefined) });
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ config: makeConfig({ claudeModel: 'haiku' }), sessionManager: sm }),
        makeCtx(), 'hello', adapter,
      );

      expect(capturedOptions.model).toBe('haiku');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('应该传递 thread 相关参数', async () => {
      const adapter = makeAdapter();
      const ctx = makeCtx({
        threadId: 'thread-abc',
        threadRootMsgId: 'root-msg-123',
      });

      const promise = runClaudeTask(makeDeps(), ctx, 'hello', adapter);

      expect(capturedOptions.threadId).toBe('thread-abc');
      expect(capturedOptions.threadRootMsgId).toBe('root-msg-123');

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });

    it('skipPermissions 为 true 时应该传递', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(
        makeDeps({ config: makeConfig({ claudeSkipPermissions: true }) }),
        makeCtx(), 'hello', adapter,
      );

      expect(capturedOptions.skipPermissions).toBe(true);

      await capturedCallbacks.onComplete!(makeResult());
      await promise;
    });
  });

  // ── 14. Completion note format ────────────────────────────────────────────

  describe('完成 note 格式', () => {
    it('note 应该包含耗时、费用、模型', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult({
        cost: 0.1234,
        durationMs: 12345,
        model: 'claude-opus',
      }));
      await promise;

      const note = (adapter.sendComplete as any).mock.calls[0][1] as string;
      expect(note).toContain('12.3s');
      expect(note).toContain('$0.1234');
      expect(note).toContain('claude-opus');
    });

    it('使用 result 字段作为 fallback', async () => {
      const adapter = makeAdapter();

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      await capturedCallbacks.onComplete!(makeResult({ accumulated: '', result: 'fallback content' }));
      await promise;

      expect(adapter.sendComplete).toHaveBeenCalledWith(
        'fallback content',
        expect.any(String),
        undefined,
      );
    });
  });

  // ── 15. Pending timer cleanup ─────────────────────────────────────────────

  describe('Pending timer 清理', () => {
    it('完成时应该清除 pending timer', async () => {
      const adapter = makeAdapter({ throttleMs: 100 });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      // Create a pending update
      capturedCallbacks.onText!('A');
      vi.advanceTimersByTime(50);
      capturedCallbacks.onText!('AB'); // This creates a pending timer

      // Complete before the pending timer fires
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      const callCountBeforeTimer = (adapter.streamUpdate as any).mock.calls.length;

      // Advance past the pending timer - it should not fire
      vi.advanceTimersByTime(200);

      expect(adapter.streamUpdate).toHaveBeenCalledTimes(callCountBeforeTimer);
    });
  });

  // ── 16. 截图自动发送 ─────────────────────────────────────────────────────

  describe('截图自动发送', () => {
    beforeEach(() => {
      mockAccess.mockResolvedValue(undefined);
    });

    it('检测到截图工具 → 完成后调用 sendImage', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/screenshot.png' });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).toHaveBeenCalledWith('/tmp/screenshot.png');
    });

    it('绝对路径直接使用', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx({ workDir: '/project' }), 'hello', adapter);

      capturedCallbacks.onToolUse!('browser_take_screenshot', { file_path: '/absolute/path.png' });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).toHaveBeenCalledWith('/absolute/path.png');
    });

    it('相对路径基于 workDir 解析', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx({ workDir: '/project' }), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filename: 'output/shot.png' });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).toHaveBeenCalledWith('/project/output/shot.png');
    });

    it('非截图工具不触发', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('Bash', { command: 'ls' });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).not.toHaveBeenCalled();
    });

    it('无文件路径时跳过', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { quality: 80 });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).not.toHaveBeenCalled();
    });

    it('重复路径去重', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/shot.png' });
      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/shot.png' });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).toHaveBeenCalledTimes(1);
    });

    it('文件不存在时跳过', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/missing.png' });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).not.toHaveBeenCalled();
    });

    it('错误路径（onError）不发送', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/shot.png' });
      await capturedCallbacks.onError!('boom');
      await promise;

      expect(sendImage).not.toHaveBeenCalled();
    });

    it('无 sendImage 方法时不报错', async () => {
      const adapter = makeAdapter({ sendImage: undefined });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/shot.png' });
      await capturedCallbacks.onComplete!(makeResult());

      await expect(promise).resolves.toBeUndefined();
    });

    it('sendImage 失败不阻塞完成', async () => {
      const sendImage = vi.fn().mockRejectedValue(new Error('upload failed'));
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/shot.png' });
      await capturedCallbacks.onComplete!(makeResult());

      await expect(promise).resolves.toBeUndefined();
      expect(adapter.sendComplete).toHaveBeenCalled();
    });

    it('多张截图串行发送', async () => {
      const sendImage = vi.fn().mockResolvedValue(undefined);
      const adapter = makeAdapter({ sendImage });

      const promise = runClaudeTask(makeDeps(), makeCtx(), 'hello', adapter);

      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/a.png' });
      capturedCallbacks.onToolUse!('take_screenshot', { filePath: '/tmp/b.png' });
      await capturedCallbacks.onComplete!(makeResult());
      await promise;

      expect(sendImage).toHaveBeenCalledTimes(2);
      expect(sendImage).toHaveBeenNthCalledWith(1, '/tmp/a.png');
      expect(sendImage).toHaveBeenNthCalledWith(2, '/tmp/b.png');
    });
  });
});
