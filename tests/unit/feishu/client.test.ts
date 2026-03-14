import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClientInstance = {
  request: vi.fn(),
};
const mockWSClientInstance = {
  start: vi.fn(),
  close: vi.fn(),
};

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: vi.fn().mockImplementation(function () {
      return mockClientInstance;
    }),
    WSClient: vi.fn().mockImplementation(function () {
      return mockWSClientInstance;
    }),
    LoggerLevel: { info: 2 },
    EventDispatcher: vi.fn().mockImplementation(function () {
      return {};
    }),
  };
});

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as Lark from '@larksuiteoapi/node-sdk';

describe('feishu/client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('getClient 在初始化前应抛出错误', async () => {
    const { getClient } = await import('../../../src/feishu/client.js');
    expect(() => getClient()).toThrow('Feishu client not initialized');
  });

  it('initFeishu 成功获取 bot openId', async () => {
    mockClientInstance.request.mockResolvedValue({ bot: { open_id: 'ou_test123' } });

    const { initFeishu, getClient, getBotOpenId } = await import('../../../src/feishu/client.js');
    const dispatcher = new Lark.EventDispatcher();

    await initFeishu(
      { feishuAppId: 'app_id', feishuAppSecret: 'secret' } as any,
      dispatcher,
    );

    expect(getClient()).toBeDefined();
    expect(getBotOpenId()).toBe('ou_test123');
  });

  it('bot info 获取失败时优雅降级', async () => {
    mockClientInstance.request.mockRejectedValue(new Error('Network error'));

    const { initFeishu, getBotOpenId } = await import('../../../src/feishu/client.js');
    const dispatcher = new Lark.EventDispatcher();

    // 不应抛出异常
    await initFeishu(
      { feishuAppId: 'app_id', feishuAppSecret: 'secret' } as any,
      dispatcher,
    );

    expect(getBotOpenId()).toBeUndefined();
  });
});
