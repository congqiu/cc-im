import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockSendMessage = vi.fn();
const mockEditMessageText = vi.fn();
const mockSendChatAction = vi.fn();

vi.mock('../../../src/telegram/client.js', () => ({
  getBot: () => ({
    telegram: {
      sendMessage: mockSendMessage,
      editMessageText: mockEditMessageText,
      sendChatAction: mockSendChatAction,
    },
  }),
}));

import {
  sendThinkingMessage,
  updateMessage,
  sendFinalMessages,
  sendTextReply,
  startTypingLoop,
  sendPermissionMessage,
  updatePermissionMessage,
  _resetCooldowns,
} from '../../../src/telegram/message-sender.js';

describe('telegram/message-sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCooldowns();
  });

  describe('sendThinkingMessage', () => {
    it('发送思考消息并添加停止按钮', async () => {
      mockSendMessage.mockResolvedValue({ message_id: 42 });
      mockEditMessageText.mockResolvedValue({});

      const id = await sendThinkingMessage('12345');
      expect(id).toBe('42');
      expect(mockSendMessage).toHaveBeenCalledWith(12345, expect.stringContaining('思考中'), {});
      expect(mockEditMessageText).toHaveBeenCalledWith(
        12345, 42, undefined,
        expect.any(String),
        expect.objectContaining({ reply_markup: expect.any(Object) }),
      );
    });
  });

  describe('updateMessage', () => {
    it('streaming 状态带停止按钮', async () => {
      mockEditMessageText.mockResolvedValue({});
      await updateMessage('100', '1', 'content', 'streaming');
      expect(mockEditMessageText).toHaveBeenCalledWith(
        100, 1, undefined,
        expect.stringContaining('content'),
        expect.objectContaining({ reply_markup: expect.any(Object) }),
      );
    });

    it('done 状态无停止按钮', async () => {
      mockEditMessageText.mockResolvedValue({});
      await updateMessage('100', '1', 'done content', 'done', 'note');
      expect(mockEditMessageText).toHaveBeenCalledWith(
        100, 1, undefined,
        expect.stringContaining('done content'),
        expect.not.objectContaining({ reply_markup: expect.any(Object) }),
      );
    });

    it('message is not modified 错误被忽略', async () => {
      mockEditMessageText.mockRejectedValue(new Error('message is not modified'));
      // Should not throw
      await updateMessage('100', '1', 'content', 'streaming');
    });

    it('Too Many Requests 错误设置 cooldown', async () => {
      mockEditMessageText.mockRejectedValue(new Error('Too Many Requests: retry after 5'));
      await updateMessage('100', '1', 'content', 'streaming');
      // Subsequent streaming update should be skipped due to cooldown
      mockEditMessageText.mockResolvedValue({});
      await updateMessage('100', '1', 'content2', 'streaming');
      // Second call should be skipped (cooldown)
      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
    });

    it('其他错误被记录但不抛出', async () => {
      mockEditMessageText.mockRejectedValue(new Error('some other error'));
      await updateMessage('100', '1', 'content', 'done');
      // Should not throw
    });

    it('非标准错误对象不抛出', async () => {
      mockEditMessageText.mockRejectedValue('string error');
      await expect(updateMessage('100', '1', 'content', 'done')).resolves.toBeUndefined();
    });
  });

  describe('sendFinalMessages', () => {
    it('短内容直接更新原消息', async () => {
      mockEditMessageText.mockResolvedValue({});
      await sendFinalMessages('100', '1', 'short content', 'note');
      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('长内容分片发送', async () => {
      mockEditMessageText.mockResolvedValue({});
      mockSendMessage.mockResolvedValue({ message_id: 2 });

      const longContent = 'x'.repeat(5000);
      await sendFinalMessages('100', '1', longContent, 'note');

      expect(mockEditMessageText).toHaveBeenCalled(); // First part updates original
      expect(mockSendMessage).toHaveBeenCalled(); // Continuation parts
    });

    it('续发消息失败不阻塞', async () => {
      mockEditMessageText.mockResolvedValue({});
      mockSendMessage.mockRejectedValue(new Error('send failed'));

      const longContent = 'x'.repeat(5000);
      await sendFinalMessages('100', '1', longContent, 'note');
    });
  });

  describe('sendTextReply', () => {
    it('发送文本消息', async () => {
      mockSendMessage.mockResolvedValue({});
      await sendTextReply('100', 'hello');
      expect(mockSendMessage).toHaveBeenCalledWith(100, 'hello');
    });

    it('发送失败不抛出', async () => {
      mockSendMessage.mockRejectedValue(new Error('fail'));
      await expect(sendTextReply('100', 'hello')).resolves.toBeUndefined();
    });
  });

  describe('startTypingLoop', () => {
    it('立即发送 typing 状态并返回停止函数', () => {
      vi.useFakeTimers();
      try {
        mockSendChatAction.mockResolvedValue({});

        const stop = startTypingLoop('100');
        expect(mockSendChatAction).toHaveBeenCalledWith(100, 'typing');

        // Advance timer to trigger another typing
        vi.advanceTimersByTime(5000);
        expect(mockSendChatAction).toHaveBeenCalledTimes(2);

        stop();

        // After stop, no more typing
        vi.advanceTimersByTime(5000);
        expect(mockSendChatAction).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('sendPermissionMessage', () => {
    it('发送权限确认消息', async () => {
      mockSendMessage.mockResolvedValue({ message_id: 99 });
      const id = await sendPermissionMessage('100', 'req-1', 'Bash', { command: 'rm -rf' });
      expect(id).toBe('99');
      expect(mockSendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining('权限确认'),
        expect.objectContaining({ reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }) }),
      );
    });
  });

  describe('updatePermissionMessage', () => {
    it('更新允许决定', async () => {
      mockEditMessageText.mockResolvedValue({});
      await updatePermissionMessage('100', '99', 'Bash', 'allow');
      expect(mockEditMessageText).toHaveBeenCalledWith(
        100, 99, undefined,
        expect.stringContaining('已允许'),
      );
    });

    it('更新拒绝决定', async () => {
      mockEditMessageText.mockResolvedValue({});
      await updatePermissionMessage('100', '99', 'Bash', 'deny');
      expect(mockEditMessageText).toHaveBeenCalledWith(
        100, 99, undefined,
        expect.stringContaining('已拒绝'),
      );
    });

    it('更新失败不抛出', async () => {
      mockEditMessageText.mockRejectedValue(new Error('fail'));
      await updatePermissionMessage('100', '99', 'Bash', 'allow');
    });
  });
});
