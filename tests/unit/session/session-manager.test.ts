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
  realpath: vi.fn().mockImplementation((path: string) => Promise.resolve(path)),
}));

// Import after mocks
import { SessionManager } from '../../../src/session/session-manager.js';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockRealpath = vi.mocked(fsPromises.realpath);

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

  it('newSession 应该生成新 convId', () => {
    const sm = new SessionManager('/work', ['/work']);
    sm.setSessionId('user1', 'old-session');
    const oldConvId = sm.getConvId('user1');

    const created = sm.newSession('user1');

    expect(created).toBe(true);
    expect(sm.getSessionId('user1')).toBeUndefined();

    const newConvId = sm.getConvId('user1');
    expect(newConvId).not.toBe(oldConvId);
  });

  it('newSession 对不存在的用户应该返回 false', () => {
    const sm = new SessionManager('/work', ['/work']);

    const created = sm.newSession('nonexistent');
    expect(created).toBe(false);
  });

  it('setWorkDir 应该成功切换目录', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRealpath.mockResolvedValue('/other');
    const sm = new SessionManager('/work', ['/work', '/other']);

    const resolved = await sm.setWorkDir('user1', '/other');

    expect(resolved).toBe('/other');
    expect(sm.getWorkDir('user1')).toBe('/other');
  });

  it('setWorkDir 目录不存在应该抛异常', async () => {
    mockExistsSync.mockReturnValue(false);
    const sm = new SessionManager('/work', ['/work']);

    await expect(sm.setWorkDir('user1', '/nonexistent')).rejects.toThrow(/目录不存在/);
  });

  it('setWorkDir 不在允许范围应该抛异常', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRealpath.mockResolvedValue('/forbidden');
    const sm = new SessionManager('/work', ['/work']);

    await expect(sm.setWorkDir('user1', '/forbidden')).rejects.toThrow('目录不在允许范围内');
  });

  it('setWorkDir 应该重置 sessionId 和 convId', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRealpath.mockResolvedValue('/other');
    const sm = new SessionManager('/work', ['/work', '/other']);
    sm.setSessionId('user1', 'old-session');
    const oldConvId = sm.getConvId('user1');

    await sm.setWorkDir('user1', '/other');

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

  it('getSessionIdForConv 应该从缓存读取旧 convId', async () => {
    const sm = new SessionManager('/work', ['/work']);
    sm.setSessionId('user1', 'old-session');
    const oldConvId = sm.getConvId('user1');

    // 切换目录会保存旧 convId 的 sessionId
    mockExistsSync.mockReturnValue(true);
    mockRealpath.mockResolvedValue('/work');
    await sm.setWorkDir('user1', '/work');

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

    // 应该调用writeFileSync
    expect(mockWriteFileSync).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ─── Thread Session Tests ───

  describe('Thread Sessions', () => {
    it('getThreadSession 不存在应该返回 undefined', () => {
      const sm = new SessionManager('/work', ['/work']);
      expect(sm.getThreadSession('user1', 'thread-123')).toBeUndefined();
    });

    it('setThreadSession 应该创建话题会话', () => {
      const sm = new SessionManager('/work', ['/work']);
      const threadSession = {
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      };

      sm.setThreadSession('user1', 'thread-123', threadSession);

      const retrieved = sm.getThreadSession('user1', 'thread-123');
      expect(retrieved).toEqual(threadSession);
    });

    it('setThreadSession 为新用户应该自动创建 UserSession', () => {
      const sm = new SessionManager('/work', ['/work']);
      const threadSession = {
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      };

      sm.setThreadSession('newuser', 'thread-123', threadSession);

      expect(sm.getThreadSession('newuser', 'thread-123')).toEqual(threadSession);
      expect(sm.getWorkDir('newuser')).toBe('/work');
    });

    it('removeThreadSession 应该删除话题会话', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-123', {
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      });

      sm.removeThreadSession('user1', 'thread-123');

      expect(sm.getThreadSession('user1', 'thread-123')).toBeUndefined();
    });

    it('getSessionIdForThread 应该返回话题的 sessionId', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-123', {
        sessionId: 'session-abc',
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      });

      expect(sm.getSessionIdForThread('user1', 'thread-123')).toBe('session-abc');
    });

    it('setSessionIdForThread 应该更新话题的 sessionId', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-123', {
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      });

      sm.setSessionIdForThread('user1', 'thread-123', 'new-session');

      expect(sm.getSessionIdForThread('user1', 'thread-123')).toBe('new-session');
    });

    it('getWorkDirForThread 应该返回话题的工作目录', () => {
      const sm = new SessionManager('/work', ['/work', '/other']);
      sm.setThreadSession('user1', 'thread-123', {
        workDir: '/other',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      });

      expect(sm.getWorkDirForThread('user1', 'thread-123')).toBe('/other');
    });

    it('getWorkDirForThread 话题不存在应该返回用户默认目录', () => {
      const sm = new SessionManager('/work', ['/work']);
      expect(sm.getWorkDirForThread('user1', 'nonexistent')).toBe('/work');
    });

    it('setWorkDirForThread 应该切换话题的工作目录', async () => {
      mockExistsSync.mockReturnValue(true);
      mockRealpath.mockResolvedValue('/other');
      const sm = new SessionManager('/work', ['/work', '/other']);
      sm.setThreadSession('user1', 'thread-123', {
        sessionId: 'old-session',
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      });

      const resolved = await sm.setWorkDirForThread('user1', 'thread-123', '/other');

      expect(resolved).toBe('/other');
      expect(sm.getWorkDirForThread('user1', 'thread-123')).toBe('/other');
      // 切换目录应该重置 sessionId
      expect(sm.getSessionIdForThread('user1', 'thread-123')).toBeUndefined();
    });

    it('setWorkDirForThread 话题不存在应该自动创建', async () => {
      mockExistsSync.mockReturnValue(true);
      mockRealpath.mockResolvedValue('/other');
      const sm = new SessionManager('/work', ['/work', '/other']);

      const resolved = await sm.setWorkDirForThread('user1', 'new-thread', '/other', 'msg-root');

      expect(resolved).toBe('/other');
      expect(sm.getWorkDirForThread('user1', 'new-thread')).toBe('/other');
      const thread = sm.getThreadSession('user1', 'new-thread');
      expect(thread).toBeDefined();
      expect(thread?.rootMessageId).toBe('msg-root');
      expect(thread?.threadId).toBe('new-thread');
    });

    it('newThreadSession 应该重置话题的 sessionId', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-123', {
        sessionId: 'old-session',
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
      });

      const success = sm.newThreadSession('user1', 'thread-123');

      expect(success).toBe(true);
      expect(sm.getSessionIdForThread('user1', 'thread-123')).toBeUndefined();
    });

    it('newThreadSession 话题不存在应该返回 false', () => {
      const sm = new SessionManager('/work', ['/work']);
      const success = sm.newThreadSession('user1', 'nonexistent');
      expect(success).toBe(false);
    });

    it('listThreads 应该返回所有话题会话', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-1', {
        workDir: '/work',
        rootMessageId: 'msg-1',
        threadId: 'thread-1',
      });
      sm.setThreadSession('user1', 'thread-2', {
        sessionId: 'session-2',
        workDir: '/work',
        rootMessageId: 'msg-2',
        threadId: 'thread-2',
        displayName: 'My Thread',
      });

      const threads = sm.listThreads('user1');

      expect(threads).toHaveLength(2);
      expect(threads[0].threadId).toBe('thread-1');
      expect(threads[1].threadId).toBe('thread-2');
      expect(threads[1].displayName).toBe('My Thread');
    });

    it('listThreads 无话题应该返回空数组', () => {
      const sm = new SessionManager('/work', ['/work']);
      expect(sm.listThreads('user1')).toEqual([]);
    });

    it('话题会话应该持久化', () => {
      vi.useFakeTimers();
      const sm = new SessionManager('/work', ['/work']);

      sm.setThreadSession('user1', 'thread-123', {
        sessionId: 'session-abc',
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
        displayName: 'Test Thread',
      });

      vi.advanceTimersByTime(1000);

      expect(mockWriteFileSync).toHaveBeenCalled();
      const savedData = JSON.parse(mockWriteFileSync.mock.calls[mockWriteFileSync.mock.calls.length - 1][1] as string);
      expect(savedData.user1.threads).toBeDefined();
      expect(savedData.user1.threads['thread-123']).toEqual({
        sessionId: 'session-abc',
        workDir: '/work',
        rootMessageId: 'msg-root',
        threadId: 'thread-123',
        displayName: 'Test Thread',
      });

      vi.useRealTimers();
    });
  });

  describe('Model 管理', () => {
    it('getModel 无用户时返回 undefined', () => {
      const sm = new SessionManager('/work', ['/work']);
      expect(sm.getModel('nonexistent')).toBeUndefined();
    });

    it('setModel/getModel 用户级别', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setSessionId('user1', 's1');

      sm.setModel('user1', 'opus');
      expect(sm.getModel('user1')).toBe('opus');
    });

    it('setModel 用户不存在时自动创建 session', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setModel('newuser', 'sonnet');
      expect(sm.getModel('newuser')).toBe('sonnet');
    });

    it('setModel/getModel 话题级别优先于用户级别', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setSessionId('user1', 's1');
      sm.setModel('user1', 'sonnet');
      sm.setThreadSession('user1', 'thread-1', {
        workDir: '/work', rootMessageId: 'msg', threadId: 'thread-1',
      });
      sm.setModel('user1', 'opus', 'thread-1');

      expect(sm.getModel('user1', 'thread-1')).toBe('opus');
      expect(sm.getModel('user1')).toBe('sonnet');
    });

    it('setModel undefined 清除模型选择', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setSessionId('user1', 's1');
      sm.setModel('user1', 'opus');
      sm.setModel('user1', undefined);
      expect(sm.getModel('user1')).toBeUndefined();
    });

    it('setModel 话题不存在时设置用户级模型', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setSessionId('user1', 's1');
      // user1 没有 thread-999 这个话题
      sm.setModel('user1', 'haiku', 'thread-999');

      // 应该fallback到用户级别
      expect(sm.getModel('user1', 'thread-999')).toBe('haiku');
      expect(sm.getModel('user1')).toBe('haiku');
    });
  });

  describe('Turns 管理', () => {
    it('addTurns 累加用户对话轮次', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setSessionId('user1', 's1');

      expect(sm.addTurns('user1', 3)).toBe(3);
      expect(sm.addTurns('user1', 2)).toBe(5);
    });

    it('addTurns 用户不存在返回 0', () => {
      const sm = new SessionManager('/work', ['/work']);
      expect(sm.addTurns('nonexistent', 1)).toBe(0);
    });

    it('addTurnsForThread 累加话题对话轮次', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-1', {
        workDir: '/work', rootMessageId: 'msg', threadId: 'thread-1',
      });

      expect(sm.addTurnsForThread('user1', 'thread-1', 2)).toBe(2);
      expect(sm.addTurnsForThread('user1', 'thread-1', 3)).toBe(5);
    });

    it('addTurnsForThread 话题不存在返回 0', () => {
      const sm = new SessionManager('/work', ['/work']);
      // 用户存在但没有话题
      sm.setSessionId('user1', 's1');
      expect(sm.addTurnsForThread('user1', 'nonexistent', 1)).toBe(0);
    });
  });

  describe('removeThreadByRootMessageId', () => {
    it('根据根消息 ID 删除话题', () => {
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-1', {
        workDir: '/work', rootMessageId: 'msg-root-1', threadId: 'thread-1',
      });

      const removed = sm.removeThreadByRootMessageId('msg-root-1');
      expect(removed).toBe(true);
      expect(sm.getThreadSession('user1', 'thread-1')).toBeUndefined();
    });

    it('根消息 ID 不存在返回 false', () => {
      const sm = new SessionManager('/work', ['/work']);
      expect(sm.removeThreadByRootMessageId('nonexistent')).toBe(false);
    });
  });

  describe('flushSync 错误处理', () => {
    it('writeFileSync 抛出时 flushSync 传播异常', () => {
      mockExistsSync.mockReturnValue(true);
      const sm = new SessionManager('/work', ['/work']);
      sm.setSessionId('user1', 's1');

      // newSession 内部调用 flushSync
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });

      expect(() => sm.newSession('user1')).toThrow('disk full');

      // 恢复 mock，避免影响后续测试
      mockWriteFileSync.mockImplementation(() => {});
    });
  });

  describe('load 旧数据无 activeConvId 自动补全', () => {
    it('加载无 activeConvId 的 UserSession 自动生成', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        user1: { workDir: '/work' },
      }));

      const sm = new SessionManager('/work', ['/work']);
      const convId = sm.getConvId('user1');
      expect(convId).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  describe('load 非法数据处理', () => {
    it('加载 null 数据时应该正常启动', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('null');

      expect(() => new SessionManager('/work', ['/work'])).not.toThrow();
    });

    it('加载空对象数据时应该正常启动', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{}');

      expect(() => new SessionManager('/work', ['/work'])).not.toThrow();
    });

    it('加载非对象数据时应该忽略', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('"string data"');

      const sm = new SessionManager('/work', ['/work']);
      expect(sm.getWorkDir('user1')).toBe('/work'); // 使用默认目录
    });

    it('加载缺少 workDir 的对象时被忽略', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({
        user1: { sessionId: 'sess-1' }, // 缺少 workDir，应该被 isUserSession 拒绝
      }));

      const sm = new SessionManager('/work', ['/work']);
      // 由于缺少 workDir，isUserSession 返回 false，session 不会被加载
      expect(sm.getWorkDir('user1')).toBe('/work');
      expect(sm.getSessionId('user1')).toBeUndefined();
    });
  });

  describe('路径遍历安全', () => {
    it('setWorkDir 应该使用 realpath 解析符号链接', async () => {
      mockExistsSync.mockReturnValue(true);
      // 符号链接 /work/evil 实际指向 /etc
      mockRealpath.mockResolvedValue('/etc');
      const sm = new SessionManager('/work', ['/work']);

      await expect(sm.setWorkDir('user1', '/work/evil')).rejects.toThrow('目录不在允许范围内');
    });

    it('setWorkDirForThread 应该使用 realpath 解析符号链接', async () => {
      mockExistsSync.mockReturnValue(true);
      mockRealpath.mockResolvedValue('/etc');
      const sm = new SessionManager('/work', ['/work']);
      sm.setThreadSession('user1', 'thread-1', {
        workDir: '/work',
        rootMessageId: 'msg',
        threadId: 'thread-1',
      });

      await expect(sm.setWorkDirForThread('user1', 'thread-1', '/work/evil')).rejects.toThrow('目录不在允许范围内');
    });

    it('setWorkDir 符号链接指向允许目录应该通过', async () => {
      mockExistsSync.mockReturnValue(true);
      mockRealpath.mockResolvedValue('/allowed/real');
      const sm = new SessionManager('/work', ['/work', '/allowed/real']);

      const resolved = await sm.setWorkDir('user1', '/work/link');
      expect(resolved).toBe('/allowed/real');
    });
  });
});
