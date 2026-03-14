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

    it('首次更新且有 taskKey 时通过 sendMessage 单独发送停止按钮卡片', async () => {
      mockReplyStream.mockResolvedValue({});
      mockSendMessage.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any, 'task-key-1');
      await sender.sendStreamUpdate('hello');
      // 流式内容通过 replyStream 发送
      expect(mockReplyStream).toHaveBeenCalledWith(frame, expect.any(String), 'hello', false);
      // 停止按钮通过 sendMessage 独立发送
      expect(mockSendMessage).toHaveBeenCalledWith('chat1', {
        msgtype: 'template_card',
        template_card: expect.objectContaining({
          card_type: 'button_interaction',
          button_list: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining('停止') }),
          ]),
        }),
      });
    });

    it('停止按钮卡片只发送一次', async () => {
      mockReplyStream.mockResolvedValue({});
      mockSendMessage.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any, 'task-key-1');
      await sender.sendStreamUpdate('first');
      await sender.sendStreamUpdate('second');
      // sendMessage 只应被调用一次（停止卡片）
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendStreamComplete', () => {
    it('结束流式并发送最终内容', async () => {
      mockReplyStream.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);
      await sender.sendStreamComplete('done', '耗时 5s');
      expect(mockReplyStream).toHaveBeenCalledWith(
        frame,
        expect.any(String),
        'done\n\n---\n> 耗时 5s',
        true,
      );
    });

    it('长内容分片发送后续部分', async () => {
      mockReplyStream.mockResolvedValue({});
      mockSendMessage.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);

      // 生成超长内容（超过 MAX_WECOM_MESSAGE_LENGTH = 4000）
      const longContent = 'x'.repeat(5000);
      await sender.sendStreamComplete(longContent, 'note');

      // 第一片通过 replyStream 发送
      expect(mockReplyStream).toHaveBeenCalledWith(
        frame,
        expect.any(String),
        expect.stringContaining('note'),
        true,
      );
      // 后续分片通过 sendMessage 发送
      expect(mockSendMessage).toHaveBeenCalled();
    });

    it('replyStream 失败时 fallback 到 sendMessage', async () => {
      mockReplyStream.mockRejectedValue(new Error('stream error'));
      mockSendMessage.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);
      await sender.sendStreamComplete('content', 'note');
      expect(mockSendMessage).toHaveBeenCalledWith('chat1', {
        msgtype: 'markdown',
        markdown: { content: expect.stringContaining('content') },
      });
    });
  });

  describe('sendStreamError', () => {
    it('发送错误消息并结束流', async () => {
      mockReplyStream.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);
      await sender.sendStreamError('something failed');
      expect(mockReplyStream).toHaveBeenCalledWith(
        frame,
        expect.any(String),
        '❌ 错误\n\nsomething failed',
        true,
      );
    });

    it('replyStream 失败时 fallback 到 sendMessage', async () => {
      mockReplyStream.mockRejectedValue(new Error('stream error'));
      mockSendMessage.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);
      await sender.sendStreamError('fail');
      expect(mockSendMessage).toHaveBeenCalledWith('chat1', {
        msgtype: 'markdown',
        markdown: { content: '❌ 错误\n\nfail' },
      });
    });
  });

  describe('cleanupStream', () => {
    it('cleanup 后 sendStreamUpdate 不报错', async () => {
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);
      sender.cleanupStream();
      // cleanup 后调用不应抛异常，也不应调用 replyStream
      await sender.sendStreamUpdate('after cleanup');
      expect(mockReplyStream).not.toHaveBeenCalled();
    });
  });

  describe('resetStreamForTextSwitch', () => {
    it('结束思考流并开启新流发送文本内容（有 taskKey）', async () => {
      mockReplyStream.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any, 'user1:1');

      await sender.resetStreamForTextSwitch('Hello', 'Let me think about this...');

      const calls = mockReplyStream.mock.calls;
      expect(calls.length).toBe(2);
      // 第一次：结束思考流，保留完整思考内容
      expect(calls[0][2]).toBe('💭 **思考过程**\n\nLet me think about this...');
      expect(calls[0][3]).toBe(true);
      // 第二次：新流发送文本内容
      expect(calls[1][2]).toBe('Hello');
      expect(calls[1][3]).toBe(false);
      // 两次使用不同的 streamId
      expect(calls[0][1]).not.toBe(calls[1][1]);
    });

    it('结束思考流并开启新流发送文本内容（无 taskKey 不带按钮）', async () => {
      mockReplyStream.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);

      await sender.resetStreamForTextSwitch('Hello', 'Let me think about this...');

      const calls = mockReplyStream.mock.calls;
      expect(calls.length).toBe(2);
      // 第一次：结束思考流
      expect(calls[0][2]).toBe('💭 **思考过程**\n\nLet me think about this...');
      expect(calls[0][3]).toBe(true);
      // 第二次：新流发送文本内容（无按钮）
      expect(calls[1][2]).toBe('Hello');
      expect(calls[1][3]).toBe(false);
      expect(calls[0][1]).not.toBe(calls[1][1]);
    });

    it('后续 sendStreamUpdate 不带思考前缀', async () => {
      mockReplyStream.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };
      sender.initStream(frame as any);

      await sender.resetStreamForTextSwitch('Hello', 'thinking...');
      mockReplyStream.mockClear();

      await sender.sendStreamUpdate('Hello world');
      expect(mockReplyStream).toHaveBeenCalledWith(
        frame,
        expect.any(String),
        'Hello world',
        false,
      );
    });
  });

  describe('renewStreamIfNeeded', () => {
    it('超时后自动续接流', async () => {
      mockReplyStream.mockResolvedValue({});
      const sender = createWecomSender(mockWsClient as any);
      const frame = { headers: { req_id: 'test-req' }, body: { chatid: 'chat1', from: { userid: 'u1' } } };

      const baseTime = 1000000;
      const nowSpy = vi.spyOn(Date, 'now');
      // initStream 内部调用 Date.now() 记录 streamStartedAt
      nowSpy.mockReturnValue(baseTime);
      sender.initStream(frame as any);

      // sendStreamUpdate 内部 renewStreamIfNeeded 调用 Date.now() 计算 elapsed
      // 让 elapsed > 330_000ms 触发续接
      nowSpy.mockReturnValue(baseTime + 331_000);

      await sender.sendStreamUpdate('content after timeout');

      // 应该先结束旧流（finish=true），然后用新 streamId 发送新内容
      const calls = mockReplyStream.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      // 第一次调用应是 finish=true（续接结束旧流）
      expect(calls[0][3]).toBe(true);
      // 第二次调用应是 finish=false（新流发送内容）
      expect(calls[1][3]).toBe(false);

      nowSpy.mockRestore();
    });
  });
});
