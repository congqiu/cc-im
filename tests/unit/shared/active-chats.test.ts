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
  existsSync: vi.fn(),
}));

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import { loadActiveChats, getActiveChatId, setActiveChatId } from '../../../src/shared/active-chats.js';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockWriteFile = vi.mocked(fsPromises.writeFile);
const mockMkdir = vi.mocked(fsPromises.mkdir);

/** Flush pending microtasks (resolved promises) */
const flushPromises = () => vi.waitFor(() => {});

describe('active-chats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset module state: load an empty object from "file"
    // Note: loadActiveChats does NOT reset data when existsSync returns false,
    // so we must load '{}' explicitly to clear any leftover state.
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{}');
    loadActiveChats();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('loadActiveChats', () => {
    it('从文件加载已有数据', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ feishu: 'chat_123', telegram: 'tg_456' }));

      loadActiveChats();

      expect(getActiveChatId('feishu')).toBe('chat_123');
      expect(getActiveChatId('telegram')).toBe('tg_456');
    });

    it('文件不存在时正常处理', () => {
      mockExistsSync.mockReturnValue(false);

      loadActiveChats();

      expect(getActiveChatId('feishu')).toBeUndefined();
      expect(getActiveChatId('telegram')).toBeUndefined();
    });

    it('JSON 格式错误时正常处理', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('not valid json{{{');

      loadActiveChats();

      expect(getActiveChatId('feishu')).toBeUndefined();
      expect(getActiveChatId('telegram')).toBeUndefined();
    });

    it('readFileSync 抛异常时正常处理', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => { throw new Error('read error'); });

      loadActiveChats();

      expect(getActiveChatId('feishu')).toBeUndefined();
    });
  });

  describe('getActiveChatId', () => {
    it('未设置的平台返回 undefined', () => {
      expect(getActiveChatId('feishu')).toBeUndefined();
      expect(getActiveChatId('telegram')).toBeUndefined();
    });

    it('设置后返回正确的值', () => {
      setActiveChatId('feishu', 'chat_abc');
      expect(getActiveChatId('feishu')).toBe('chat_abc');
    });

    it('不同平台互不影响', () => {
      setActiveChatId('feishu', 'feishu_id');
      setActiveChatId('telegram', 'tg_id');

      expect(getActiveChatId('feishu')).toBe('feishu_id');
      expect(getActiveChatId('telegram')).toBe('tg_id');
    });
  });

  describe('setActiveChatId', () => {
    it('设置并可以获取值', () => {
      setActiveChatId('telegram', 'tg_999');
      expect(getActiveChatId('telegram')).toBe('tg_999');
    });

    it('值相同时跳过保存', async () => {
      setActiveChatId('feishu', 'chat_same');
      vi.advanceTimersByTime(500);
      await flushPromises();

      vi.clearAllMocks();

      // 再次设置相同值
      setActiveChatId('feishu', 'chat_same');
      vi.advanceTimersByTime(500);
      await flushPromises();

      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('值不同时触发保存', async () => {
      setActiveChatId('feishu', 'chat_1');
      vi.advanceTimersByTime(500);
      await flushPromises();

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      const savedJson = mockWriteFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(savedJson);
      expect(parsed.feishu).toBe('chat_1');
    });

    it('防抖：多次快速设置只保存一次', async () => {
      setActiveChatId('feishu', 'v1');
      vi.advanceTimersByTime(100);
      setActiveChatId('feishu', 'v2');
      vi.advanceTimersByTime(100);
      setActiveChatId('feishu', 'v3');

      // 尚未触发保存
      expect(mockWriteFile).not.toHaveBeenCalled();

      // 等待防抖结束
      vi.advanceTimersByTime(500);
      await flushPromises();

      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const savedJson = mockWriteFile.mock.calls[0][1] as string;
      const parsed = JSON.parse(savedJson);
      expect(parsed.feishu).toBe('v3');
    });

    it('防抖：间隔足够长时分别保存', async () => {
      setActiveChatId('feishu', 'first');
      vi.advanceTimersByTime(500);
      await flushPromises();
      expect(mockWriteFile).toHaveBeenCalledTimes(1);

      setActiveChatId('feishu', 'second');
      vi.advanceTimersByTime(500);
      await flushPromises();
      expect(mockWriteFile).toHaveBeenCalledTimes(2);
    });
  });
});
