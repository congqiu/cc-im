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
const mockReplyStream = vi.fn();
const mockReplyStreamWithCard = vi.fn();

const mockWsClient = {
  sendMessage: mockSendMessage,
  replyStream: mockReplyStream,
  replyStreamWithCard: mockReplyStreamWithCard,
};

vi.mock('../../../src/wecom/client.js', () => ({
  getWSClient: () => mockWsClient,
}));

import { createWecomSender, sendTextReply } from '../../../src/wecom/message-sender.js';

describe('wecom/message-sender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createWecomSender', () => {
    it('导出所有预期方法', () => {
      const sender = createWecomSender(mockWsClient as any);
      expect(sender.sendTextReply).toBeTypeOf('function');
      expect(sender.initStream).toBeTypeOf('function');
      expect(sender.sendStreamUpdate).toBeTypeOf('function');
      expect(sender.resetStreamForTextSwitch).toBeTypeOf('function');
      expect(sender.sendStreamComplete).toBeTypeOf('function');
      expect(sender.sendStreamError).toBeTypeOf('function');
      expect(sender.cleanupStream).toBeTypeOf('function');
      expect(sender.sendPermissionCard).toBeTypeOf('function');
      expect(sender.updatePermissionCard).toBeTypeOf('function');
      expect(sender.sendImage).toBeTypeOf('function');
    });
  });

  describe('sendTextReply', () => {
    it('通过 sendMessage 发送 markdown 消息', async () => {
      mockSendMessage.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      await sender.sendTextReply('chat1', 'hello world');
      expect(mockSendMessage).toHaveBeenCalledWith('chat1', {
        msgtype: 'markdown',
        markdown: { content: 'hello world' },
      });
    });

    it('独立 sendTextReply 函数使用 getWSClient()', async () => {
      mockSendMessage.mockResolvedValue({});
      await sendTextReply('chat2', 'standalone message');
      expect(mockSendMessage).toHaveBeenCalledWith('chat2', {
        msgtype: 'markdown',
        markdown: { content: 'standalone message' },
      });
    });
  });

  describe('sendPermissionCard', () => {
    it('发送包含 2 个按钮的模板卡片', async () => {
      mockSendMessage.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const msgId = await sender.sendPermissionCard('chat1', 'req123', 'Bash', { command: 'ls' });
      expect(mockSendMessage).toHaveBeenCalledWith('chat1', {
        msgtype: 'template_card',
        template_card: expect.objectContaining({
          card_type: 'button_interaction',
          button_list: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('允许'), key: 'perm_allow_req123' }),
            expect.objectContaining({ text: expect.stringContaining('拒绝'), key: 'perm_deny_req123' }),
          ]),
        }),
      });
      expect(msgId).toBe('');
    });
  });

  describe('sendStreamUpdate', () => {
    it('initStream 后调用 replyStream', async () => {
      mockReplyStream.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);
      await sender.sendStreamUpdate('hello');
      expect(mockReplyStream).toHaveBeenCalledWith(
        frame,
        expect.any(String),
        'hello',
        false,
      );
    });

    it('首次更新且有 taskKey 时使用 replyStreamWithCard', async () => {
      mockReplyStreamWithCard.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any, 'task-key-1');
      await sender.sendStreamUpdate('hello');
      expect(mockReplyStreamWithCard).toHaveBeenCalledWith(
        frame,
        expect.any(String),
        'hello',
        false,
        expect.objectContaining({
          templateCard: expect.objectContaining({
            card_type: 'button_interaction',
            button_list: expect.arrayContaining([
              expect.objectContaining({ text: expect.stringContaining('停止') }),
            ]),
          }),
        }),
      );
    });
  });
});
