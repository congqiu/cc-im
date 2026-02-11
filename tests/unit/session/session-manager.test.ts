import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { SessionManager } from '../../../src/session/session-manager.js';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockWriteFile = vi.mocked(fsPromises.writeFile);

describe('SessionManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false); // 默认文件不存在
    mockReadFileSync.mockReturnValue('{}');
  });

  it('新用户应该获取默认工作目录', () => {
    const sm = new SessionManager('/default/work', ['/default/work']);
    expect(sm.getWorkDir('user1')).toBe('/default/work');
  });

  it('应该设置和获取 sessionId', () => {
    const sm = new SessionManager('/work', ['/work']);

    sm.setSessionId('user1', 'session-123');
    expect(sm.getSessionId('user1')).toBe('session-123');
  });

  it('为不存在的用户设置 sessionId 应该自动创建 session', () => {
    const sm = new SessionManager('/work', ['/work']);

    sm.setSessionId('newuser', 'session-456');
    expect(sm.getSessionId('newuser')).toBe('session-456');
    expect(sm.getWorkDir('newuser')).toBe('/work');
  });

  it('getConvId 应该为新用户生成 convId', () => {
    const sm = new SessionManager('/work', ['/work']);

    const convId = sm.getConvId('user1');
    expect(convId).toMatch(/^[0-9a-f]{8}$/); // 8位hex
  });

  it('getConvId 已有 convId 应该直接返回', () => {
    const sm = new SessionManager('/work', ['/work']);

    const convId1 = sm.getConvId('user1');
    const convId2 = sm.getConvId('user1');
    expect(convId1).toBe(convId2);
  });

  it('clearSession 应该生成新 convId', () => {
    const sm = new SessionManager('/work', ['/work']);
    sm.setSessionId('user1', 'old-session');
    const oldConvId = sm.getConvId('user1');

    const cleared = sm.clearSession('user1');

    expect(cleared).toBe(true);
    expect(sm.getSessionId('user1')).toBeUndefined();

    const newConvId = sm.getConvId('user1');
    expect(newConvId).not.toBe(oldConvId);
  });

  it('clearSession 对不存在的用户应该返回 false', () => {
    const sm = new SessionManager('/work', ['/work']);

    const cleared = sm.clearSession('nonexistent');
    expect(cleared).toBe(false);
  });

  it('setWorkDir 应该成功切换目录', () => {
    mockExistsSync.mockReturnValue(true);
    const sm = new SessionManager('/work', ['/work', '/other']);

    const resolved = sm.setWorkDir('user1', '/other');

    expect(resolved).toBe('/other');
    expect(sm.getWorkDir('user1')).toBe('/other');
  });

  it('setWorkDir 目录不存在应该抛异常', () => {
    mockExistsSync.mockReturnValue(false);
    const sm = new SessionManager('/work', ['/work']);

    expect(() => sm.setWorkDir('user1', '/nonexistent')).toThrow(/目录不存在/);
  });

  it('setWorkDir 不在允许范围应该抛异常', () => {
    mockExistsSync.mockReturnValue(true);
    const sm = new SessionManager('/work', ['/work']);

    expect(() => sm.setWorkDir('user1', '/forbidden')).toThrow('目录不在允许范围内');
  });

  it('setWorkDir 应该重置 sessionId 和 convId', () => {
    mockExistsSync.mockReturnValue(true);
    const sm = new SessionManager('/work', ['/work', '/other']);
    sm.setSessionId('user1', 'old-session');
    const oldConvId = sm.getConvId('user1');

    sm.setWorkDir('user1', '/other');

    expect(sm.getSessionId('user1')).toBeUndefined();
    const newConvId = sm.getConvId('user1');
    expect(newConvId).not.toBe(oldConvId);
  });

  it('getSessionIdForConv 应该读取当前活跃 convId', () => {
    const sm = new SessionManager('/work', ['/work']);
    sm.setSessionId('user1', 'session-123');
    const convId = sm.getConvId('user1');

    const sessionId = sm.getSessionIdForConv('user1', convId);
    expect(sessionId).toBe('session-123');
  });

  it('getSessionIdForConv 应该从缓存读取旧 convId', () => {
    const sm = new SessionManager('/work', ['/work']);
    sm.setSessionId('user1', 'old-session');
    const oldConvId = sm.getConvId('user1');

    // 切换目录会保存旧 convId 的 sessionId
    mockExistsSync.mockReturnValue(true);
    sm.setWorkDir('user1', '/work');

    // 新 convId 没有 sessionId
    const newConvId = sm.getConvId('user1');
    expect(sm.getSessionIdForConv('user1', newConvId)).toBeUndefined();

    // 旧 convId 应该能读取到
    expect(sm.getSessionIdForConv('user1', oldConvId)).toBe('old-session');
  });

  it('setSessionIdForConv 应该更新当前 convId', () => {
    const sm = new SessionManager('/work', ['/work']);
    const convId = sm.getConvId('user1');

    sm.setSessionIdForConv('user1', convId, 'new-session');

    expect(sm.getSessionId('user1')).toBe('new-session');
  });

  it('setSessionIdForConv 应该存储旧 convId 到缓存', () => {
    const sm = new SessionManager('/work', ['/work']);
    const oldConvId = 'old-conv-id';

    sm.setSessionIdForConv('user1', oldConvId, 'old-session');

    expect(sm.getSessionIdForConv('user1', oldConvId)).toBe('old-session');
  });

  it('应该加载旧格式数据（字符串 sessionId）', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      user1: 'old-session-id',
    }));

    const sm = new SessionManager('/work', ['/work']);

    expect(sm.getSessionId('user1')).toBe('old-session-id');
    expect(sm.getWorkDir('user1')).toBe('/work');
  });

  it('应该加载新格式数据', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({
      user1: {
        sessionId: 'new-session',
        workDir: '/custom',
        activeConvId: 'conv123',
      },
    }));

    const sm = new SessionManager('/work', ['/work', '/custom']);

    expect(sm.getSessionId('user1')).toBe('new-session');
    expect(sm.getWorkDir('user1')).toBe('/custom');
    expect(sm.getConvId('user1')).toBe('conv123');
  });

  it('文件不存在时应该正常启动', () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => new SessionManager('/work', ['/work'])).not.toThrow();
  });

  it('连续修改session应该触发debounced save', () => {
    vi.useFakeTimers();
    const sm = new SessionManager('/work', ['/work']);

    // 连续设置sessionId应该触发save
    sm.setSessionId('user1', 'session-1');
    sm.setSessionId('user1', 'session-2');
    sm.setSessionId('user1', 'session-3');

    // Fast-forward debounce timer
    vi.advanceTimersByTime(1000);

    // 应该调用writeFile
    expect(mockWriteFile).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
