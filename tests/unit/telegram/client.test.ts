import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockGetMe = vi.fn();
const mockLaunch = vi.fn();
const mockStop = vi.fn();
const mockOn = vi.fn();

vi.mock('telegraf', () => ({
  Telegraf: class MockTelegraf {
    telegram = { getMe: mockGetMe };
    launch = mockLaunch;
    stop = mockStop;
    on = mockOn;
    constructor() {}
  },
}));

import { getBot, initTelegram, stopTelegram } from '../../../src/telegram/client.js';
import type { Config } from '../../../src/config.js';

const baseConfig = {
  telegramBotToken: 'test-token',
  enabledPlatforms: ['telegram'],
} as Config;

describe('telegram/client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initTelegram 初始化并启动 bot', async () => {
    mockGetMe.mockResolvedValue({ id: 123, username: 'test_bot' });
    mockLaunch.mockReturnValue(new Promise(() => {})); // Never resolves (polling)

    const setupHandlers = vi.fn();
    await initTelegram(baseConfig, setupHandlers);

    expect(setupHandlers).toHaveBeenCalled();
    expect(mockGetMe).toHaveBeenCalled();
    expect(mockLaunch).toHaveBeenCalled();
  });

  it('initTelegram 连接失败时抛出错误', async () => {
    mockGetMe.mockRejectedValue(new Error('Network error'));

    await expect(initTelegram(baseConfig, vi.fn())).rejects.toThrow('Network error');
  });

  it('stopTelegram 停止 bot', async () => {
    // 先初始化 bot，避免依赖其他测试的执行顺序
    mockGetMe.mockResolvedValue({ id: 123, username: 'test_bot' });
    mockLaunch.mockReturnValue(new Promise(() => {}));
    await initTelegram(baseConfig, vi.fn());
    mockStop.mockClear();

    stopTelegram();
    expect(mockStop).toHaveBeenCalledWith('SIGTERM');
  });
});
