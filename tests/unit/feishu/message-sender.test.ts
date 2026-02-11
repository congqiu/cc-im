import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Lark client
const mockCreate = vi.fn();
const mockPatch = vi.fn();

vi.mock('../../../src/feishu/client.js', () => ({
  getClient: () => ({
    im: {
      v1: {
        message: {
          create: mockCreate,
          patch: mockPatch,
        },
      },
    },
  }),
}));

// Import after mocks
import { sendThinkingCard, updateCard, sendFinalCards, sendTextReply } from '../../../src/feishu/message-sender.js';

describe('MessageSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({ data: { message_id: 'msg-123' } });
    mockPatch.mockResolvedValue({});
  });

  describe('sendThinkingCard', () => {
    it('应该调用 create 和 patch', async () => {
      const chatId = 'chat-123';

      const messageId = await sendThinkingCard(chatId);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: expect.any(String),
          msg_type: 'interactive',
        },
      });

      expect(mockPatch).toHaveBeenCalledTimes(1);
      expect(messageId).toBe('msg-123');
    });

    it('应该返回 messageId', async () => {
      const messageId = await sendThinkingCard('chat-456');

      expect(messageId).toBe('msg-123');
    });
  });

  describe('updateCard', () => {
    it('应该调用 patch 更新卡片', async () => {
      const messageId = 'msg-789';
      const content = 'Updated content';

      await updateCard(messageId, content, 'streaming', 'Processing...');

      expect(mockPatch).toHaveBeenCalledWith({
        path: { message_id: messageId },
        data: {
          content: expect.any(String),
        },
      });

      const callData = mockPatch.mock.calls[0][0].data.content;
      expect(callData).toContain('Updated content');
    });

    it('API 异常不应该抛出', async () => {
      mockPatch.mockRejectedValueOnce(new Error('API error'));

      await expect(
        updateCard('msg-error', 'content', 'done')
      ).resolves.not.toThrow();

      expect(mockPatch).toHaveBeenCalled();
    });
  });

  describe('sendFinalCards', () => {
    it('短内容应该只更新原卡片', async () => {
      const chatId = 'chat-123';
      const messageId = 'msg-456';
      const content = 'Short content';

      await sendFinalCards(chatId, messageId, content, 'Done');

      expect(mockPatch).toHaveBeenCalledTimes(1);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('长内容应该创建续卡片', async () => {
      const chatId = 'chat-789';
      const messageId = 'msg-long';
      const longContent = 'x'.repeat(5000); // 超过单卡片限制

      await sendFinalCards(chatId, messageId, longContent, 'Done');

      expect(mockPatch).toHaveBeenCalledTimes(1); // 更新原卡片
      expect(mockCreate.mock.calls.length).toBeGreaterThan(0); // 创建续卡片

      // 检查续卡片的 note 包含 "续"
      const createCalls = mockCreate.mock.calls;
      if (createCalls.length > 0) {
        const cardContent = JSON.parse(createCalls[0][0].data.content);
        const noteElement = cardContent.elements.find((el: any) => el.tag === 'note');
        if (noteElement) {
          expect(noteElement.elements[0].content).toContain('续');
        }
      }
    });
  });

  describe('sendTextReply', () => {
    it('应该发送纯文本消息', async () => {
      const chatId = 'chat-text';
      const text = 'Hello, world!';

      await sendTextReply(chatId, text);

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    });

    it('API 异常不应该抛出', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        sendTextReply('chat-fail', 'test')
      ).resolves.not.toThrow();
    });
  });
});
