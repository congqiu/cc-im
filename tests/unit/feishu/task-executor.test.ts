import { describe, it, expect, vi, beforeEach } from 'vitest';

let capturedAdapter: any = null;
let capturedCtx: any = null;

vi.mock('../../../src/feishu/message-sender.js', () => ({
  sendThinkingCard: vi.fn(),
  streamContentUpdate: vi.fn().mockResolvedValue(undefined),
  sendFinalCards: vi.fn().mockResolvedValue(undefined),
  sendErrorCard: vi.fn().mockResolvedValue(undefined),
  sendTextReply: vi.fn().mockResolvedValue(undefined),
  uploadAndSendImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/feishu/card-builder.js', () => ({
  buildCardV2: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/feishu/cardkit-manager.js', () => ({
  destroySession: vi.fn(),
  updateCardFull: vi.fn().mockResolvedValue(undefined),
  disableStreaming: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/shared/claude-task.js', () => ({
  runClaudeTask: vi.fn(async (_deps: any, ctx: any, _prompt: string, adapter: any) => {
    capturedCtx = ctx;
    capturedAdapter = adapter;
  }),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { handleStopAction, executeClaudeTask, type TaskInfo, type TaskExecutorDeps } from '../../../src/feishu/task-executor.js';
import { disableStreaming, updateCardFull, destroySession } from '../../../src/feishu/cardkit-manager.js';
import { buildCardV2 } from '../../../src/feishu/card-builder.js';
import { sendThinkingCard, streamContentUpdate, sendFinalCards, sendErrorCard, sendTextReply, uploadAndSendImage } from '../../../src/feishu/message-sender.js';
import { runClaudeTask } from '../../../src/shared/claude-task.js';

function makeDeps(overrides?: Partial<TaskExecutorDeps>): TaskExecutorDeps {
  return {
    config: { agentCliPath: 'claude', agentSkipPermissions: false, agentTimeoutMs: 600000, hookPort: 18900 } as any,
    sessionManager: {
      getSessionIdForThread: vi.fn(() => 'thread-sid'),
      getSessionIdForConv: vi.fn(() => 'conv-sid'),
    } as any,
    userCosts: new Map(),
    runningTasks: new Map(),
    ...overrides,
  };
}

describe('task-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedAdapter = null;
    capturedCtx = null;
  });

  describe('handleStopAction', () => {
    it('应停止正在运行的任务', () => {
      const runningTasks = new Map<string, TaskInfo>();
      const mockAbort = vi.fn();
      const mockSettle = vi.fn();

      runningTasks.set('user1:card1', {
        cardId: 'card1',
        messageId: 'msg1',
        latestContent: '部分输出',
        handle: { abort: mockAbort } as any,
        settle: mockSettle,
        startedAt: Date.now(),
      });

      handleStopAction(runningTasks, 'user1', 'card1');

      expect(mockSettle).toHaveBeenCalled();
      expect(mockAbort).toHaveBeenCalled();
      expect(runningTasks.has('user1:card1')).toBe(false);
    });

    it('应在停止任务时调用 buildCardV2 并触发卡片更新', async () => {
      const runningTasks = new Map<string, TaskInfo>();
      const mockAbort = vi.fn();
      const mockSettle = vi.fn();
      vi.mocked(disableStreaming).mockResolvedValue(undefined);
      vi.mocked(updateCardFull).mockResolvedValue(undefined);

      runningTasks.set('user1:card2', {
        cardId: 'card2',
        messageId: 'msg2',
        latestContent: '已有输出内容',
        handle: { abort: mockAbort } as any,
        settle: mockSettle,
        startedAt: Date.now(),
      });

      handleStopAction(runningTasks, 'user1', 'card2');

      expect(buildCardV2).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'done', note: '⏹️ 已停止' }),
      );
      // 等待异步链完成
      await vi.runAllTimersAsync?.().catch(() => {});
      await Promise.resolve();
      expect(disableStreaming).toHaveBeenCalledWith('card2');
    });

    it('任务不存在时应记录警告但不抛出异常', () => {
      const runningTasks = new Map<string, TaskInfo>();
      expect(() => {
        handleStopAction(runningTasks, 'user1', 'card-nonexistent');
      }).not.toThrow();
      expect(runningTasks.size).toBe(0);
    });

    it('任务不存在时不应调用卡片更新', () => {
      const runningTasks = new Map<string, TaskInfo>();
      handleStopAction(runningTasks, 'user1', 'card-nonexistent');
      expect(disableStreaming).not.toHaveBeenCalled();
      expect(updateCardFull).not.toHaveBeenCalled();
      expect(destroySession).not.toHaveBeenCalled();
    });

    it('latestContent 为空时应使用默认提示文本', () => {
      const runningTasks = new Map<string, TaskInfo>();
      const mockAbort = vi.fn();
      const mockSettle = vi.fn();

      runningTasks.set('user1:card3', {
        cardId: 'card3',
        messageId: 'msg3',
        latestContent: '',
        handle: { abort: mockAbort } as any,
        settle: mockSettle,
        startedAt: Date.now(),
      });

      handleStopAction(runningTasks, 'user1', 'card3');

      expect(buildCardV2).toHaveBeenCalledWith(
        expect.objectContaining({ content: '(任务已停止，暂无输出)' }),
      );
    });

    it('latestContent 有内容时应使用实际内容', () => {
      const runningTasks = new Map<string, TaskInfo>();
      const mockAbort = vi.fn();
      const mockSettle = vi.fn();

      runningTasks.set('user1:card4', {
        cardId: 'card4',
        messageId: 'msg4',
        latestContent: '实际输出内容',
        handle: { abort: mockAbort } as any,
        settle: mockSettle,
        startedAt: Date.now(),
      });

      handleStopAction(runningTasks, 'user1', 'card4');

      expect(buildCardV2).toHaveBeenCalledWith(
        expect.objectContaining({ content: '实际输出内容' }),
      );
    });
  });

  describe('executeClaudeTask', () => {
    beforeEach(() => {
      vi.mocked(sendThinkingCard).mockResolvedValue({ messageId: 'msg-x', cardId: 'card-y' } as any);
    });

    describe('Session ID 解析', () => {
      it('有 threadCtx 时应使用 getSessionIdForThread', async () => {
        const deps = makeDeps();
        const threadCtx = { threadId: 't1', rootMessageId: 'root-1' };

        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work', undefined, threadCtx);

        expect(deps.sessionManager.getSessionIdForThread).toHaveBeenCalledWith('u1', 't1');
        expect(deps.sessionManager.getSessionIdForConv).not.toHaveBeenCalled();
        expect(capturedCtx.sessionId).toBe('thread-sid');
      });

      it('无 threadCtx 但有 convId 时应使用 getSessionIdForConv', async () => {
        const deps = makeDeps();

        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work', 'conv-123');

        expect(deps.sessionManager.getSessionIdForConv).toHaveBeenCalledWith('u1', 'conv-123');
        expect(deps.sessionManager.getSessionIdForThread).not.toHaveBeenCalled();
        expect(capturedCtx.sessionId).toBe('conv-sid');
      });

      it('既无 threadCtx 也无 convId 时 sessionId 应为 undefined', async () => {
        const deps = makeDeps();

        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        expect(deps.sessionManager.getSessionIdForThread).not.toHaveBeenCalled();
        expect(deps.sessionManager.getSessionIdForConv).not.toHaveBeenCalled();
        expect(capturedCtx.sessionId).toBeUndefined();
      });
    });

    describe('sendThinkingCard 失败', () => {
      it('sendThinkingCard 抛出异常时不应调用 runClaudeTask', async () => {
        vi.mocked(sendThinkingCard).mockRejectedValue(new Error('card fail'));
        const deps = makeDeps();

        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        expect(runClaudeTask).not.toHaveBeenCalled();
      });

      it('cardId 为空字符串时不应调用 runClaudeTask', async () => {
        vi.mocked(sendThinkingCard).mockResolvedValue({ messageId: 'msg-x', cardId: '' } as any);
        const deps = makeDeps();

        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        expect(runClaudeTask).not.toHaveBeenCalled();
      });
    });

    describe('参数传递', () => {
      it('capturedCtx 应包含正确的 platform、taskKey、threadId、threadRootMsgId', async () => {
        const deps = makeDeps();
        const threadCtx = { threadId: 't1', rootMessageId: 'root-1' };

        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work', 'conv-1', threadCtx);

        expect(capturedCtx.platform).toBe('feishu');
        expect(capturedCtx.taskKey).toBe('u1:card-y');
        expect(capturedCtx.threadId).toBe('t1');
        expect(capturedCtx.threadRootMsgId).toBe('root-1');
        expect(capturedCtx.userId).toBe('u1');
        expect(capturedCtx.chatId).toBe('chat-1');
        expect(capturedCtx.workDir).toBe('/work');
      });

      it('adapter.throttleMs 应等于 CARDKIT_THROTTLE_MS (80)', async () => {
        const deps = makeDeps();

        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        expect(capturedAdapter.throttleMs).toBe(80);
      });
    });

    describe('Adapter 回调', () => {
      it('streamUpdate 应调用 streamContentUpdate', async () => {
        const deps = makeDeps();
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        capturedAdapter.streamUpdate('hello content', 'tool note');

        // streamContentUpdate 是异步的，但 streamUpdate 以 fire-and-forget 方式调用
        expect(streamContentUpdate).toHaveBeenCalledWith('card-y', 'hello content', 'tool note');
      });

      it('sendComplete 应调用 sendFinalCards', async () => {
        const deps = makeDeps();
        const threadCtx = { threadId: 't1', rootMessageId: 'root-1' };
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work', undefined, threadCtx);

        await capturedAdapter.sendComplete('final content', 'some note', 'thinking');

        expect(sendFinalCards).toHaveBeenCalledWith('chat-1', 'msg-x', 'card-y', 'final content', 'some note', threadCtx, 'thinking');
      });

      it('sendComplete 在群组且被 @ 时应调用 sendTextReply 发送 at-mention', async () => {
        const deps = makeDeps();
        const threadCtx = { threadId: 't1', rootMessageId: 'root-1' };
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work', undefined, threadCtx, true, true);

        await capturedAdapter.sendComplete('final', 'note', undefined);

        expect(sendTextReply).toHaveBeenCalledWith(
          'chat-1',
          expect.stringContaining('u1'),
          threadCtx,
        );
        expect(sendTextReply).toHaveBeenCalledWith(
          'chat-1',
          expect.stringContaining('任务已完成'),
          threadCtx,
        );
      });

      it('sendComplete 非群组时不应调用 sendTextReply', async () => {
        const deps = makeDeps();
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        await capturedAdapter.sendComplete('final', 'note', undefined);

        expect(sendTextReply).not.toHaveBeenCalled();
      });

      it('sendError 应调用 sendErrorCard', async () => {
        const deps = makeDeps();
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        await capturedAdapter.sendError('something went wrong');

        expect(sendErrorCard).toHaveBeenCalledWith('card-y', 'something went wrong');
      });

      it('onThinkingToText 应调用 buildCardV2 和 updateCardFull', async () => {
        const deps = makeDeps();
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        capturedAdapter.onThinkingToText('new content', 'thinking text');

        expect(buildCardV2).toHaveBeenCalledWith(
          expect.objectContaining({ content: 'new content', status: 'streaming' }),
          'card-y',
        );
        expect(updateCardFull).toHaveBeenCalledWith('card-y', expect.anything());
      });

      it('extraCleanup 应从 runningTasks 中删除 taskKey', async () => {
        const runningTasks = new Map<string, TaskInfo>();
        const deps = makeDeps({ runningTasks });
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        // 先通过 onTaskReady 添加任务
        const taskKey = 'u1:card-y';
        capturedAdapter.onTaskReady({ latestContent: '', handle: { abort: vi.fn() }, settle: vi.fn(), startedAt: Date.now() });
        expect(runningTasks.has(taskKey)).toBe(true);

        // extraCleanup 应删除任务
        capturedAdapter.extraCleanup();
        expect(runningTasks.has(taskKey)).toBe(false);
      });

      it('onTaskReady 应在 runningTasks 中存储包含 cardId 和 messageId 的任务信息', async () => {
        const runningTasks = new Map<string, TaskInfo>();
        const deps = makeDeps({ runningTasks });
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work');

        const state = { latestContent: 'some output', handle: { abort: vi.fn() }, settle: vi.fn(), startedAt: Date.now() };
        capturedAdapter.onTaskReady(state);

        const taskKey = 'u1:card-y';
        const stored = runningTasks.get(taskKey);
        expect(stored).toBeDefined();
        expect(stored!.cardId).toBe('card-y');
        expect(stored!.messageId).toBe('msg-x');
        expect(stored!.latestContent).toBe('some output');
      });

      it('sendImage 应调用 uploadAndSendImage', async () => {
        const deps = makeDeps();
        const threadCtx = { threadId: 't1', rootMessageId: 'root-1' };
        await executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work', undefined, threadCtx);

        await capturedAdapter.sendImage('/tmp/screenshot.png');

        expect(uploadAndSendImage).toHaveBeenCalledWith('chat-1', '/tmp/screenshot.png', threadCtx);
      });
    });

    it('runClaudeTask 抛出异常时应向外传播', async () => {
      vi.mocked(runClaudeTask).mockRejectedValueOnce(new Error('claude crashed'));
      const deps = makeDeps();

      await expect(executeClaudeTask(deps, 'u1', 'chat-1', 'prompt', '/work')).rejects.toThrow('claude crashed');
    });
  });
});
