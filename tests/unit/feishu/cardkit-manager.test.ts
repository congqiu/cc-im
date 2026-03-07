import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockCardCreate = vi.fn();
const mockCardSettings = vi.fn();
const mockCardUpdate = vi.fn();
const mockElementContent = vi.fn();
const mockMessageCreate = vi.fn();
const mockMessageReply = vi.fn();

vi.mock('../../../src/feishu/client.js', () => ({
  getClient: () => ({
    cardkit: {
      v1: {
        card: {
          create: mockCardCreate,
          settings: mockCardSettings,
          update: mockCardUpdate,
        },
        cardElement: { content: mockElementContent },
      },
    },
    im: {
      v1: {
        message: {
          create: mockMessageCreate,
          reply: mockMessageReply,
        },
      },
    },
  }),
}));

import {
  createCard,
  enableStreaming,
  streamContent,
  updateCardFull,
  sendCardMessage,
  replyCardMessage,
  disableStreaming,
  markCompleted,
  destroySession,
} from '../../../src/feishu/cardkit-manager.js';

describe('cardkit-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createCard', () => {
    it('创建卡片并返回 cardId', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-1' } });
      const id = await createCard('{}');
      expect(id).toBe('card-1');
    });

    it('无 card_id 时抛出错误', async () => {
      mockCardCreate.mockResolvedValue({ code: 100, msg: 'fail', data: {} });
      await expect(createCard('{}')).rejects.toThrow('card.create returned no card_id');
    });
  });

  describe('enableStreaming', () => {
    it('启用流式模式', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-s1' } });
      await createCard('{}');

      mockCardSettings.mockResolvedValue({ code: 0 });
      await enableStreaming('card-s1');
      expect(mockCardSettings).toHaveBeenCalled();
    });

    it('API 返回错误码时抛出', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-s2' } });
      await createCard('{}');

      mockCardSettings.mockResolvedValue({ code: 500, msg: 'error' });
      await expect(enableStreaming('card-s2')).rejects.toThrow('enableStreaming error');
    });

    it('200400 限频时不重试直接抛出', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-s3' } });
      await createCard('{}');

      mockCardSettings.mockResolvedValue({ code: 200400, msg: 'rate limited' });
      await expect(enableStreaming('card-s3')).rejects.toThrow('rate limited');
      // NonRetryableError 不重试，settings 只调用 1 次
      expect(mockCardSettings).toHaveBeenCalledTimes(1);
    });

    it('已完成的卡片跳过 enableStreaming', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-s4' } });
      await createCard('{}');
      mockCardSettings.mockResolvedValue({ code: 0 });
      await enableStreaming('card-s4');
      mockCardSettings.mockClear();

      // disableStreaming 会标记 completed
      await disableStreaming('card-s4');
      mockCardSettings.mockClear();

      // 再次 enableStreaming 应该直接返回
      await enableStreaming('card-s4');
      expect(mockCardSettings).not.toHaveBeenCalled();
    });
  });

  describe('streamContent', () => {
    it('成功更新内容', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc1' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 0 });
      await streamContent('card-sc1', 'el-1', 'hello');
      expect(mockElementContent).toHaveBeenCalled();
    });

    it('忽略 200810 用户交互错误', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc2' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 200810 });
      await streamContent('card-sc2', 'el-1', 'hello'); // should not throw
    });

    it('忽略 300317 sequence 冲突', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc3' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 300317 });
      await streamContent('card-sc3', 'el-1', 'hello');
    });

    it('忽略 200400 限频', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc4' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 200400 });
      await streamContent('card-sc4', 'el-1', 'hello');
    });

    it('忽略 200937 更新过于频繁', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc4b' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 200937 });
      await streamContent('card-sc4b', 'el-1', 'hello');
    });

    it('忽略 200740 卡片已失效', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc4c' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 200740 });
      await streamContent('card-sc4c', 'el-1', 'hello');
    });

    it('200850 流式超时时重新启用并重试', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc5' } });
      await createCard('{}');

      mockElementContent
        .mockResolvedValueOnce({ code: 200850 })
        .mockResolvedValueOnce({ code: 0 });
      mockCardSettings.mockResolvedValue({ code: 0 });

      await streamContent('card-sc5', 'el-1', 'hello');
      expect(mockCardSettings).toHaveBeenCalled(); // re-enable
      expect(mockElementContent).toHaveBeenCalledTimes(2); // original + retry
    });

    it('300309 流式关闭时重新启用并重试', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc5b' } });
      await createCard('{}');

      mockElementContent
        .mockResolvedValueOnce({ code: 300309 })
        .mockResolvedValueOnce({ code: 0 });
      mockCardSettings.mockResolvedValue({ code: 0 });

      await streamContent('card-sc5b', 'el-1', 'hello');
      expect(mockCardSettings).toHaveBeenCalled();
    });

    it('已完成的卡片不重试 200850', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc6' } });
      await createCard('{}');
      markCompleted('card-sc6');

      mockElementContent.mockResolvedValue({ code: 200850 });
      await streamContent('card-sc6', 'el-1', 'hello');
      expect(mockCardSettings).not.toHaveBeenCalled(); // no re-enable
    });

    it('重新启用失败时静默跳过', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc7' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 200850 });
      mockCardSettings.mockRejectedValue(new Error('fail'));

      await streamContent('card-sc7', 'el-1', 'hello'); // should not throw
    });

    it('200850 重启流式后发现已完成则跳过重试', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc9' } });
      await createCard('{}');

      mockElementContent.mockResolvedValueOnce({ code: 200850 });
      // enableStreaming 成功，但在 enableStreaming 调用过程中标记 completed
      mockCardSettings.mockImplementation(async () => {
        markCompleted('card-sc9');
        return { code: 0 };
      });

      await streamContent('card-sc9', 'el-1', 'hello');
      // enableStreaming 被调用，但后续不应再次调用 elementContent（因为已完成）
      expect(mockElementContent).toHaveBeenCalledTimes(1);
    });

    it('其他错误码不抛出', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-sc8' } });
      await createCard('{}');

      mockElementContent.mockResolvedValue({ code: 99999, msg: 'unknown' });
      await expect(streamContent('card-sc8', 'el-1', 'hello')).resolves.toBeUndefined();
    });
  });

  describe('updateCardFull', () => {
    it('成功更新卡片', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-uf1' } });
      await createCard('{}');

      mockCardUpdate.mockResolvedValue({ code: 0 });
      await updateCardFull('card-uf1', '{}');
      expect(mockCardUpdate).toHaveBeenCalled();
    });

    it('忽略 200810 用户交互', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-uf2' } });
      await createCard('{}');

      mockCardUpdate.mockResolvedValue({ code: 200810 });
      await updateCardFull('card-uf2', '{}');
    });

    it('忽略 300317 sequence 冲突', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-uf3' } });
      await createCard('{}');

      mockCardUpdate.mockResolvedValue({ code: 300317 });
      await updateCardFull('card-uf3', '{}');
    });

    it('其他错误码抛出', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-uf4' } });
      await createCard('{}');

      mockCardUpdate.mockResolvedValue({ code: 500, msg: 'error' });
      await expect(updateCardFull('card-uf4', '{}')).rejects.toThrow('updateCardFull error');
    });
  });

  describe('sendCardMessage', () => {
    it('发送卡片消息并返回 messageId', async () => {
      mockMessageCreate.mockResolvedValue({ data: { message_id: 'msg-1' } });
      const id = await sendCardMessage('chat-1', 'card-1');
      expect(id).toBe('msg-1');
    });
  });

  describe('replyCardMessage', () => {
    it('回复卡片到话题', async () => {
      mockMessageReply.mockResolvedValue({ data: { message_id: 'msg-2', thread_id: 'thread-1' } });
      const result = await replyCardMessage('root-msg', 'card-1');
      expect(result.messageId).toBe('msg-2');
      expect(result.threadId).toBe('thread-1');
    });
  });

  describe('disableStreaming', () => {
    it('关闭流式模式', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-ds1' } });
      await createCard('{}');
      // 先启用
      mockCardSettings.mockResolvedValue({ code: 0 });
      await enableStreaming('card-ds1');
      mockCardSettings.mockClear();

      // 再关闭
      mockCardSettings.mockResolvedValue({ code: 0 });
      await disableStreaming('card-ds1');
      expect(mockCardSettings).toHaveBeenCalled();
    });

    it('未启用流式时跳过', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-ds2' } });
      await createCard('{}');

      await disableStreaming('card-ds2');
      expect(mockCardSettings).not.toHaveBeenCalled();
    });

    it('不存在的 session 跳过', async () => {
      await disableStreaming('nonexistent');
      expect(mockCardSettings).not.toHaveBeenCalled();
    });

    it('API 错误不抛出', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-ds3' } });
      await createCard('{}');
      mockCardSettings.mockResolvedValue({ code: 0 });
      await enableStreaming('card-ds3');

      mockCardSettings.mockRejectedValue(new Error('fail'));
      await disableStreaming('card-ds3'); // should not throw
    });

    it('API 返回错误码时不抛出', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-ds4' } });
      await createCard('{}');
      mockCardSettings.mockResolvedValue({ code: 0 });
      await enableStreaming('card-ds4');

      mockCardSettings.mockResolvedValue({ code: 500, msg: 'err' });
      await expect(disableStreaming('card-ds4')).resolves.toBeUndefined();
    });

    it('并发调用只执行一次 API', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-ds5' } });
      await createCard('{}');
      mockCardSettings.mockResolvedValue({ code: 0 });
      await enableStreaming('card-ds5');
      mockCardSettings.mockClear();

      mockCardSettings.mockResolvedValue({ code: 0 });
      // 第一次调用
      await disableStreaming('card-ds5');
      mockCardSettings.mockClear();
      // 第二次调用因 streamingEnabled=false 提前返回，API 不再调用
      await disableStreaming('card-ds5');
      expect(mockCardSettings).toHaveBeenCalledTimes(0);
    });
  });

  describe('markCompleted / destroySession', () => {
    it('markCompleted 标记后不再重试流式超时', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-mc1' } });
      await createCard('{}');
      markCompleted('card-mc1');

      // 验证标记后 200850 不触发重新启用
      mockElementContent.mockResolvedValue({ code: 200850 });
      await streamContent('card-mc1', 'el-1', 'hello');
      expect(mockCardSettings).not.toHaveBeenCalled();
    });

    it('destroySession 清理 session', async () => {
      mockCardCreate.mockResolvedValue({ code: 0, data: { card_id: 'card-dy1' } });
      await createCard('{}');
      destroySession('card-dy1');
      // Subsequent streamContent should silently skip (session gone)
      mockElementContent.mockResolvedValue({ code: 0 });
      await streamContent('card-dy1', 'el-1', 'hello');
      expect(mockElementContent).not.toHaveBeenCalled();
    });
  });
});
