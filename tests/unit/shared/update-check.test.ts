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

const mockExistsSync = vi.fn<(path: string) => boolean>().mockReturnValue(false);
const mockReadFileSync = vi.fn<(path: string, encoding: string) => string>();
const mockWriteFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...(args as [string])),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...(args as [string, string])),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

vi.mock('../../../src/constants.js', () => ({
  APP_HOME: '/tmp/test-cc-im',
}));

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
  // 默认：无缓存文件
  mockExistsSync.mockReturnValue(false);
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

describe('checkForUpdate - 缓存', () => {
  it('缓存命中且未过期时不发起 HTTP 请求', async () => {
    const cache = { version: '9.9.9', timestamp: Date.now() - 1000 }; // 1 秒前
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(cache));

    await checkForUpdate('1.0.0');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('9.9.9'));
  });

  it('缓存命中但版本不比当前新时不提示', async () => {
    const cache = { version: '1.0.0', timestamp: Date.now() - 1000 };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(cache));

    await checkForUpdate('1.0.0');
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockLog.info).not.toHaveBeenCalled();
  });

  it('缓存过期时重新请求 npm', async () => {
    const cache = { version: '2.0.0', timestamp: Date.now() - 25 * 60 * 60 * 1000 }; // 25 小时前
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(cache));

    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '3.0.0' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockGet).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('3.0.0'));
  });

  it('缓存文件不存在时请求 npm 并写入缓存', async () => {
    mockExistsSync.mockReturnValue(false);

    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '2.0.0' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockGet).toHaveBeenCalled();
    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
  });

  it('缓存文件损坏时重新请求 npm', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not json');

    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '2.0.0' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockGet).toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
  });

  it('缓存字段缺失时重新请求 npm', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '2.0.0' })); // 缺少 timestamp

    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '3.0.0' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockGet).toHaveBeenCalled();
  });

  it('npm 请求返回 null 时不写入缓存', async () => {
    mockExistsSync.mockReturnValue(false);

    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(404, 'not found'));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('写缓存时自动创建目录', async () => {
    // 第一次 existsSync 是 readCache 检查缓存文件 → false
    // 第二次 existsSync 是 writeCache 检查目录 → false
    mockExistsSync.mockReturnValue(false);

    const req = fakeRequest();
    mockGet.mockImplementation((_url: string, _opts: unknown, cb: (res: unknown) => void) => {
      cb(fakeResponse(200, JSON.stringify({ version: '2.0.0' })));
      return req;
    });

    await checkForUpdate('1.0.0');
    expect(mockMkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
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
