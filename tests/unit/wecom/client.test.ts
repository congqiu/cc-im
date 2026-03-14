import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @wecom/aibot-node-sdk
vi.mock('@wecom/aibot-node-sdk', () => {
  const { EventEmitter } = require('events');
  class MockWSClient extends EventEmitter {
    connect() {
      // 模拟异步认证成功
      setTimeout(() => this.emit('authenticated'), 10);
      return this;
    }
    disconnect() {}
    get isConnected() { return true; }
  }
  return {
    default: { WSClient: MockWSClient },
    generateReqId: (prefix: string) => `${prefix}_test_${Date.now()}`,
  };
});

describe('wecom client', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('should export initWecom and stopWecom', async () => {
    const { initWecom, stopWecom } = await import('../../../src/wecom/client.js');
    expect(typeof initWecom).toBe('function');
    expect(typeof stopWecom).toBe('function');
  });

  it('should initialize and authenticate', async () => {
    const { initWecom } = await import('../../../src/wecom/client.js');
    const mockConfig = {
      wecomBotId: 'test-bot-id',
      wecomBotSecret: 'test-secret',
    } as any;

    const mockHandle = { stop: vi.fn(), getRunningTaskCount: vi.fn(() => 0) };
    const setupHandlers = vi.fn(() => mockHandle);

    const result = await initWecom(mockConfig, setupHandlers);
    expect(result.wsClient).toBeDefined();
    expect(result.handle).toBe(mockHandle);
    expect(setupHandlers).toHaveBeenCalledOnce();
  });
});
