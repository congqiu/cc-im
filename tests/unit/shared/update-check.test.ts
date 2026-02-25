import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => mockLog,
}));

const mockGet = vi.fn();
vi.mock('node:https', () => ({ get: (...args: unknown[]) => mockGet(...args) }));

import { checkForUpdate } from '../../../src/shared/update-check.js';

/** 构造一个假的 HTTP response */
function fakeResponse(statusCode: number, body: string) {
  const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void };
  res.statusCode = statusCode;
  res.resume = vi.fn();
  // 下一个 tick 发送数据
  setTimeout(() => {
    res.emit('data', Buffer.from(body));
    res.emit('end');
  }, 0);
  return res;
}

/** 构造一个假的 request 对象 */
function fakeRequest() {
  return new EventEmitter() as EventEmitter & { destroy: () => void };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkForUpdate', () => {
  it('有新版本时打印提示', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '9.9.9' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('9.9.9'));
  });

  it('版本相同时不提示', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '1.0.0' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('当前版本更高时不提示', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '1.0.0' })));
      return req;
    });

    await checkForUpdate('2.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('minor 版本更新时提示', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '1.2.0' })));
      return req;
    });

    await checkForUpdate('1.1.0');
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('1.2.0'));
  });

  it('patch 版本更新时提示', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '1.1.2' })));
      return req;
    });

    await checkForUpdate('1.1.1');
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('1.1.2'));
  });

  it('带 v 前缀的版本号正确比较', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '2.0.0' })));
      return req;
    });

    await checkForUpdate('v1.0.0');
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
  });
});

describe('checkForUpdate - 网络异常', () => {
  it('HTTP 非 200 时静默跳过', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(404, 'not found'));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('请求出错时静默跳过', async () => {
    mockGet.mockImplementation(() => {
      const req = fakeRequest();
      setTimeout(() => req.emit('error', new Error('network error')), 0);
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('超时时静默跳过', async () => {
    mockGet.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
      req.destroy = vi.fn();
      setTimeout(() => req.emit('timeout'), 0);
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('响应 JSON 解析失败时静默跳过', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, 'not json'));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('响应中无 version 字段时静默跳过', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ name: 'cc-im' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('version 字段非字符串时静默跳过', async () => {
    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: 123 })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockLog.info).not.toHaveBeenCalled();
  });
});
