import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...orig, PERMISSION_REQUEST_TIMEOUT_MS: 200 };
});

import {
  registerPermissionSender,
  resolvePermissionById,
  startPermissionServer,
  type PermissionSender,
} from '../../../src/hook/permission-server.js';

function createMockSender(): PermissionSender {
  return {
    sendPermissionCard: vi.fn().mockResolvedValue('msg-123'),
    updatePermissionCard: vi.fn().mockResolvedValue(undefined),
  };
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 500, data: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(port: number, path: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 500, data: JSON.parse(data) }));
    }).on('error', reject);
  });
}

describe('permission-server utilities', () => {
  it('resolvePermissionById 无请求时返回 null', () => {
    expect(resolvePermissionById('nonexistent-id', 'allow')).toBeNull();
  });
});

describe('permission-server HTTP', () => {
  let port: number;
  let serverHandle: { close: () => void };

  beforeEach(async () => {
    const handle = await startPermissionServer(0);
    port = handle.port;
    serverHandle = handle;
  });

  afterEach(async () => {
    await serverHandle?.close();
  });

  it('GET /health 返回 ok', async () => {
    const res = await get(port, '/health');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
  });

  it('未知路径返回 404', async () => {
    const res = await get(port, '/unknown');
    expect(res.status).toBe(404);
  });

  it('POST /permission-request 缺少 chatId 返回 400', async () => {
    const res = await post(port, '/permission-request', { toolName: 'Bash' });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('chatId');
  });

  it('POST /permission-request 缺少 toolName 返回 400', async () => {
    const res = await post(port, '/permission-request', { chatId: 'chat-1' });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('toolName');
  });

  it('POST /permission-request body 不是对象返回 400', async () => {
    const res = await post(port, '/permission-request', 'not-an-object');
    expect(res.status).toBe(400);
  });

  it('POST /permission-request toolInput 无效返回 400', async () => {
    const res = await post(port, '/permission-request', {
      chatId: 'chat-1',
      toolName: 'Bash',
      toolInput: 'not-an-object',
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('toolInput');
  });

  it('POST /permission-request platform 无效返回 400', async () => {
    const res = await post(port, '/permission-request', {
      chatId: 'chat-1',
      toolName: 'Bash',
      platform: 123,
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('platform');
  });

  it('POST /permission-request threadRootMsgId 无效返回 400', async () => {
    const res = await post(port, '/permission-request', {
      chatId: 'chat-1',
      toolName: 'Bash',
      threadRootMsgId: 123,
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('threadRootMsgId');
  });

  it('POST /permission-request threadId 无效返回 400', async () => {
    const res = await post(port, '/permission-request', {
      chatId: 'chat-1',
      toolName: 'Bash',
      threadId: 123,
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('threadId');
  });

  it('未注册平台时返回 deny', async () => {
    const sender = createMockSender();
    registerPermissionSender('http-test', sender);

    // Request for unregistered platform
    const res = await post(port, '/permission-request', {
      chatId: 'chat-http',
      toolName: 'Bash',
      platform: 'nonexistent-platform',
    });
    expect(res.status).toBe(200);
    expect(res.data.decision).toBe('deny');
  });

  it('权限超时后应调用 sendTextNotify 通知用户', async () => {
    const sender = createMockSender();
    sender.sendTextNotify = vi.fn().mockResolvedValue(undefined);
    registerPermissionSender('feishu', sender);

    // PERMISSION_REQUEST_TIMEOUT_MS 已被 mock 为 200ms，真实等待即可超时
    const res = await post(port, '/permission-request', {
      chatId: 'chat-timeout-test', toolName: 'Write', platform: 'feishu',
    });

    expect(res.data.decision).toBe('deny');
    expect(sender.sendTextNotify).toHaveBeenCalledWith(
      'chat-timeout-test',
      expect.stringContaining('超时'),
      undefined,
    );
  }, 10_000);

  it('注册平台后发送权限卡片并等待决定', async () => {
    const sender = createMockSender();
    registerPermissionSender('http-test-2', sender);

    // Start request (will block waiting for decision)
    const requestPromise = post(port, '/permission-request', {
      chatId: 'chat-resolve',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      platform: 'http-test-2',
    });

    // Wait for permission card to be sent
    await vi.waitFor(() => {
      expect(sender.sendPermissionCard).toHaveBeenCalled();
    });

    // Resolve the permission using requestId from the mock call
    const requestId = vi.mocked(sender.sendPermissionCard).mock.calls[0][1];
    const resolved = resolvePermissionById(requestId, 'allow');
    expect(resolved).not.toBeNull();

    const res = await requestPromise;
    expect(res.status).toBe(200);
    expect(res.data.decision).toBe('allow');
  });
});
