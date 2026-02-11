import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs before importing logger
vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
  })),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks
import { initLogger, createLogger } from '../../../src/logger.js';
import * as fs from 'node:fs';

const mockCreateWriteStream = vi.mocked(fs.createWriteStream);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    mockCreateWriteStream.mockReturnValue({
      write: vi.fn(),
    } as any);
  });

  it('initLogger 应该创建日志目录', () => {
    mockExistsSync.mockReturnValue(false);

    initLogger();

    expect(mockMkdirSync).toHaveBeenCalled();
    expect(mockCreateWriteStream).toHaveBeenCalled();
  });

  it('initLogger 目录已存在时不应该创建', () => {
    mockExistsSync.mockReturnValue(true);

    initLogger();

    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockCreateWriteStream).toHaveBeenCalled();
  });

  it('createLogger 应该返回logger对象', () => {
    initLogger();
    const logger = createLogger('Test');

    expect(logger).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
    expect(logger.debug).toBeDefined();
  });

  it('logger.info 应该记录日志', () => {
    initLogger();
    const logger = createLogger('Test');
    const writeStream = mockCreateWriteStream.mock.results[0].value;

    logger.info('test message');

    expect(writeStream.write).toHaveBeenCalled();
  });

  it('logger.error 应该记录错误', () => {
    initLogger();
    const logger = createLogger('Test');
    const writeStream = mockCreateWriteStream.mock.results[0].value;

    logger.error('error message');

    expect(writeStream.write).toHaveBeenCalled();
  });

  it('rotateOldLogs 应该删除超过限制的日志文件', () => {
    const oldLogs = Array.from({ length: 15 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}.log`);
    mockReaddirSync.mockReturnValue(oldLogs as any);
    mockExistsSync.mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({
      mtimeMs: Date.now(),
    } as any);

    initLogger();

    // 应该删除超过10个的文件
    expect(fs.unlinkSync).toHaveBeenCalledTimes(5);
  });
});
