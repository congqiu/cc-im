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

// Mock cardkit-manager
const mockCreateCard = vi.fn();
const mockEnableStreaming = vi.fn();
const mockSendCardMessage = vi.fn();
const mockStreamContent = vi.fn();
const mockUpdateCardFull = vi.fn();
const mockDestroySession = vi.fn();

vi.mock('../../../src/feishu/cardkit-manager.js', () => ({
  createCard: (...args: any[]) => mockCreateCard(...args),
  enableStreaming: (...args: any[]) => mockEnableStreaming(...args),
  sendCardMessage: (...args: any[]) => mockSendCardMessage(...args),
  streamContent: (...args: any[]) => mockStreamContent(...args),
  updateCardFull: (...args: any[]) => mockUpdateCardFull(...args),
  destroySession: (...args: any[]) => mockDestroySession(...args),
}));

// Import after mocks
import { sendThinkingCard, streamContentUpdate, sendFinalCards, sendErrorCard, sendTextReply } from '../../../src/feishu/message-sender.js';

describe('MessageSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCard.mockResolvedValue('card-abc');
    mockEnableStreaming.mockResolvedValue(undefined);
    mockSendCardMessage.mockResolvedValue('msg-123');
    mockStreamContent.mockResolvedValue(undefined);
    mockUpdateCardFull.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({ data: { message_id: 'msg-123' } });
    mockPatch.mockResolvedValue({});
  });

  describe('sendThinkingCard', () => {
    it('应该返回 CardHandle 包含 cardId 和 messageId', async () => {
      const handle = await sendThinkingCard('chat-123');

      expect(handle).toEqual({ messageId: 'msg-123', cardId: 'card-abc' });
    });

    it('应该调用 createCard、enableStreaming、sendCardMessage、updateCardFull', async () => {
      await sendThinkingCard('chat-123');

      expect(mockCreateCard).toHaveBeenCalledTimes(1);
      expect(mockEnableStreaming).toHaveBeenCalledWith('card-abc');
      expect(mockSendCardMessage).toHaveBeenCalledWith('chat-123', 'card-abc');
      // updateCardFull 补充停止按钮
      expect(mockUpdateCardFull).toHaveBeenCalledTimes(1);
      expect(mockUpdateCardFull).toHaveBeenCalledWith('card-abc', expect.any(String));
    });

    it('enableStreaming 和 sendCardMessage 应该并行执行', async () => {
      const order: string[] = [];
      mockEnableStreaming.mockImplementation(async () => { order.push('streaming'); });
      mockSendCardMessage.mockImplementation(async () => { order.push('send'); return 'msg-123'; });

      await sendThinkingCard('chat-123');

      // Both should be called (order may vary since they're parallel)
      expect(order).toContain('streaming');
      expect(order).toContain('send');
    });
  });

  describe('streamContentUpdate', () => {
    it('应该调用 cardkit streamContent', async () => {
      await streamContentUpdate('card-abc', 'Hello world');

      expect(mockStreamContent).toHaveBeenCalledWith('card-abc', 'main_content', 'Hello world');
    });

    it('空内容应该传递 "..."', async () => {
      await streamContentUpdate('card-abc', '');

      expect(mockStreamContent).toHaveBeenCalledWith('card-abc', 'main_content', '...');
    });
  });

  describe('sendFinalCards', () => {
    it('短内容应该只调用 updateCardFull', async () => {
      await sendFinalCards('chat-123', 'msg-456', 'card-abc', 'Short content', 'Done');

      expect(mockUpdateCardFull).toHaveBeenCalledTimes(1);
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockDestroySession).toHaveBeenCalledWith('card-abc');
    });

    it('长内容应该创建续卡片', async () => {
      const longContent = 'x'.repeat(5000);

      await sendFinalCards('chat-789', 'msg-long', 'card-abc', longContent, 'Done');

      expect(mockUpdateCardFull).toHaveBeenCalledTimes(1); // 更新原卡片
      expect(mockCreate.mock.calls.length).toBeGreaterThan(0); // 创建续卡片
      expect(mockDestroySession).toHaveBeenCalledWith('card-abc');
    });
  });

  describe('sendErrorCard', () => {
    it('应该调用 updateCardFull 并 destroySession', async () => {
      await sendErrorCard('card-abc', 'Something went wrong');

      expect(mockUpdateCardFull).toHaveBeenCalledTimes(1);
      const cardJson = mockUpdateCardFull.mock.calls[0][1];
      expect(cardJson).toContain('错误');
      expect(mockDestroySession).toHaveBeenCalledWith('card-abc');
    });

    it('updateCardFull 失败不应该抛出', async () => {
      mockUpdateCardFull.mockRejectedValueOnce(new Error('API error'));

      await expect(sendErrorCard('card-abc', 'error')).resolves.not.toThrow();
      expect(mockDestroySession).toHaveBeenCalledWith('card-abc');
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
