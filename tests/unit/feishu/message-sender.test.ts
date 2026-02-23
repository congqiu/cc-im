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
const mockGet = vi.fn();
const mockReply = vi.fn();

vi.mock('../../../src/feishu/client.js', () => ({
  getClient: () => ({
    im: {
      v1: {
        message: {
          create: mockCreate,
          patch: mockPatch,
          get: mockGet,
          reply: mockReply,
        },
      },
    },
  }),
}));

// Mock cardkit-manager
const mockCreateCard = vi.fn();
const mockEnableStreaming = vi.fn();
const mockSendCardMessage = vi.fn();
const mockReplyCardMessage = vi.fn();
const mockStreamContent = vi.fn();
const mockUpdateCardFull = vi.fn();
const mockDestroySession = vi.fn();
const mockMarkCompleted = vi.fn();
const mockDisableStreaming = vi.fn();

vi.mock('../../../src/feishu/cardkit-manager.js', () => ({
  createCard: (...args: any[]) => mockCreateCard(...args),
  enableStreaming: (...args: any[]) => mockEnableStreaming(...args),
  sendCardMessage: (...args: any[]) => mockSendCardMessage(...args),
  replyCardMessage: (...args: any[]) => mockReplyCardMessage(...args),
  streamContent: (...args: any[]) => mockStreamContent(...args),
  updateCardFull: (...args: any[]) => mockUpdateCardFull(...args),
  destroySession: (...args: any[]) => mockDestroySession(...args),
  markCompleted: (...args: any[]) => mockMarkCompleted(...args),
  disableStreaming: (...args: any[]) => mockDisableStreaming(...args),
}));

// Import after mocks
import {
  sendThinkingCard,
  streamContentUpdate,
  sendFinalCards,
  sendErrorCard,
  sendTextReply,
  fetchThreadDescription,
  sendPermissionCard,
  updatePermissionCard,
} from '../../../src/feishu/message-sender.js';

describe('MessageSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateCard.mockResolvedValue('card-abc');
    mockEnableStreaming.mockResolvedValue(undefined);
    mockSendCardMessage.mockResolvedValue('msg-123');
    mockReplyCardMessage.mockResolvedValue({ messageId: 'msg-reply-123' });
    mockStreamContent.mockResolvedValue(undefined);
    mockUpdateCardFull.mockResolvedValue(undefined);
    mockDisableStreaming.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({ data: { message_id: 'msg-123' } });
    mockPatch.mockResolvedValue({});
    mockGet.mockResolvedValue({ code: 0, data: { items: [] } });
    mockReply.mockResolvedValue({ data: { message_id: 'msg-reply-456' } });
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

    it('有 threadCtx 时应该使用 reply API', async () => {
      const threadCtx = { rootMessageId: 'root-msg-001', threadId: 'thread-001' };

      await sendTextReply('chat-text', 'Hello thread!', threadCtx);

      expect(mockReply).toHaveBeenCalledWith({
        path: { message_id: 'root-msg-001' },
        data: {
          content: JSON.stringify({ text: 'Hello thread!' }),
          msg_type: 'text',
          reply_in_thread: true,
        },
      });
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe('fetchThreadDescription', () => {
    it('text 消息应该返回解析后的文本', async () => {
      mockGet.mockResolvedValue({
        code: 0,
        data: {
          items: [{
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '这是话题标题' }) },
          }],
        },
      });

      const result = await fetchThreadDescription('root-msg-001');
      expect(result).toBe('这是话题标题');
      expect(mockGet).toHaveBeenCalledWith({
        path: { message_id: 'root-msg-001' },
      });
    });

    it('post 消息应该返回 title 或 body text', async () => {
      mockGet.mockResolvedValue({
        code: 0,
        data: {
          items: [{
            msg_type: 'post',
            body: {
              content: JSON.stringify({
                title: '帖子标题',
                content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'text', text: '第二行' }]],
              }),
            },
          }],
        },
      });

      const result = await fetchThreadDescription('root-msg-002');
      expect(result).toBe('帖子标题');
    });

    it('post 消息无 title 时应该返回 body text', async () => {
      mockGet.mockResolvedValue({
        code: 0,
        data: {
          items: [{
            msg_type: 'post',
            body: {
              content: JSON.stringify({
                content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'text', text: '第二行' }]],
              }),
            },
          }],
        },
      });

      const result = await fetchThreadDescription('root-msg-003');
      expect(result).toBe('第一行\n第二行');
    });

    it('非 text/post 消息应该返回 [msgType]', async () => {
      mockGet.mockResolvedValue({
        code: 0,
        data: {
          items: [{
            msg_type: 'image',
            body: { content: '{}' },
          }],
        },
      });

      const result = await fetchThreadDescription('root-msg-004');
      expect(result).toBe('[image]');
    });

    it('API 错误 (code != 0) 应该返回 undefined', async () => {
      mockGet.mockResolvedValue({
        code: 10001,
        msg: 'not found',
        data: null,
      });

      const result = await fetchThreadDescription('root-msg-005');
      expect(result).toBeUndefined();
    });

    it('无消息数据时应该返回 undefined', async () => {
      mockGet.mockResolvedValue({
        code: 0,
        data: { items: [] },
      });

      const result = await fetchThreadDescription('root-msg-006');
      expect(result).toBeUndefined();
    });

    it('异常时应该返回 undefined', async () => {
      mockGet.mockRejectedValue(new Error('Network error'));

      const result = await fetchThreadDescription('root-msg-007');
      expect(result).toBeUndefined();
    });
  });

  describe('sendPermissionCard', () => {
    it('无 threadCtx 时应该使用 create API', async () => {
      const messageId = await sendPermissionCard('chat-perm', 'req-001', 'Bash', { command: 'ls' });

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'chat-perm',
          content: expect.any(String),
          msg_type: 'interactive',
        },
      });
      expect(mockReply).not.toHaveBeenCalled();
      expect(messageId).toBe('msg-123');
    });

    it('有 threadCtx 时应该使用 reply API', async () => {
      const threadCtx = { rootMessageId: 'root-msg-perm', threadId: 'thread-perm' };

      const messageId = await sendPermissionCard('chat-perm', 'req-002', 'Write', { file: 'test.ts' }, threadCtx);

      expect(mockReply).toHaveBeenCalledWith({
        path: { message_id: 'root-msg-perm' },
        data: {
          content: expect.any(String),
          msg_type: 'interactive',
          reply_in_thread: true,
        },
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(messageId).toBe('msg-reply-456');
    });
  });

  describe('updatePermissionCard', () => {
    it('应该使用 allow 决定更新卡片', async () => {
      await updatePermissionCard('msg-perm-001', 'Bash', 'allow');

      expect(mockPatch).toHaveBeenCalledWith({
        path: { message_id: 'msg-perm-001' },
        data: {
          content: expect.any(String),
        },
      });
      // 验证卡片内容包含允许标识
      const content = mockPatch.mock.calls[0][0].data.content;
      expect(content).toContain('已允许');
    });

    it('应该使用 deny 决定更新卡片', async () => {
      await updatePermissionCard('msg-perm-002', 'Write', 'deny');

      expect(mockPatch).toHaveBeenCalledWith({
        path: { message_id: 'msg-perm-002' },
        data: {
          content: expect.any(String),
        },
      });
      const content = mockPatch.mock.calls[0][0].data.content;
      expect(content).toContain('已拒绝');
    });

    it('API 异常不应该抛出', async () => {
      mockPatch.mockRejectedValueOnce(new Error('API error'));

      await expect(
        updatePermissionCard('msg-perm-003', 'Bash', 'allow')
      ).resolves.not.toThrow();
    });
  });

  describe('sendThinkingCard with threadCtx', () => {
    it('有 threadCtx 时应该使用 replyCardMessage 而非 sendCardMessage', async () => {
      const threadCtx = { rootMessageId: 'root-msg-think', threadId: 'thread-think' };

      const handle = await sendThinkingCard('chat-think', threadCtx);

      expect(mockReplyCardMessage).toHaveBeenCalledWith('root-msg-think', 'card-abc');
      expect(mockSendCardMessage).not.toHaveBeenCalled();
      expect(handle).toEqual({ messageId: 'msg-reply-123', cardId: 'card-abc' });
    });
  });

  describe('sendFinalCards with threadCtx', () => {
    it('长内容溢出卡片有 threadCtx 时应该使用 reply API', async () => {
      const longContent = 'x'.repeat(5000);
      const threadCtx = { rootMessageId: 'root-msg-final', threadId: 'thread-final' };

      await sendFinalCards('chat-final', 'msg-final', 'card-abc', longContent, 'Done', threadCtx);

      expect(mockUpdateCardFull).toHaveBeenCalledTimes(1); // 更新原卡片
      // 溢出部分使用 reply API
      expect(mockReply).toHaveBeenCalled();
      expect(mockReply).toHaveBeenCalledWith({
        path: { message_id: 'root-msg-final' },
        data: {
          content: expect.any(String),
          msg_type: 'interactive',
          reply_in_thread: true,
        },
      });
      expect(mockCreate).not.toHaveBeenCalled(); // 不应使用 create
      expect(mockDestroySession).toHaveBeenCalledWith('card-abc');
    });
  });

  describe('streamContentUpdate with note', () => {
    it('有 note 参数时应该同时更新 main_content 和 note_area', async () => {
      await streamContentUpdate('card-abc', 'Hello world', '工具调用中...');

      expect(mockStreamContent).toHaveBeenCalledTimes(2);
      expect(mockStreamContent).toHaveBeenCalledWith('card-abc', 'main_content', 'Hello world');
      expect(mockStreamContent).toHaveBeenCalledWith('card-abc', 'note_area', '工具调用中...');
    });
  });
});
