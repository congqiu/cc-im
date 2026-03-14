import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  runClaudeTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { handleStopAction, type TaskInfo } from '../../../src/feishu/task-executor.js';
import { disableStreaming, updateCardFull, destroySession } from '../../../src/feishu/cardkit-manager.js';
import { buildCardV2 } from '../../../src/feishu/card-builder.js';

describe('task-executor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
