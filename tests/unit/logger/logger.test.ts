import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs before importing logger
vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({
    write: vi.fn(),
    end: vi.fn(),
  })),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks
import { initLogger, createLogger, closeLogger } from '../../../src/logger.js';
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
      end: vi.fn(),
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

  it('initLogger 指定 level 后低级别日志不输出', () => {
    initLogger(undefined, 'WARN');
    const logger = createLogger('Test');
    const writeStream = mockCreateWriteStream.mock.results[0].value;

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    logger.debug('should not appear');
    logger.info('should not appear either');

    // debug 和 info 都不应该写入文件流
    expect(writeStream.write).not.toHaveBeenCalled();

    // warn 应该写入
    logger.warn('this should appear');
    expect(writeStream.write).toHaveBeenCalledTimes(1);

    stdoutSpy.mockRestore();
    // 重置为 DEBUG 级别，避免影响其他测试
    initLogger(undefined, 'DEBUG');
  });

  it('logger 带额外参数时应该格式化输出', () => {
    initLogger();
    const logger = createLogger('Test');
    const writeStream = mockCreateWriteStream.mock.results[0].value;
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const error = new Error('test error');
    logger.info('something failed', error);

    const writtenLine = writeStream.write.mock.calls[0][0] as string;
    expect(writtenLine).toContain('something failed');
    expect(writtenLine).toContain('test error');

    stdoutSpy.mockRestore();
  });

  it('closeLogger 应该关闭 logStream', () => {
    initLogger();
    const writeStream = mockCreateWriteStream.mock.results[0].value;

    closeLogger();

    expect(writeStream.end).toHaveBeenCalled();
  });

  it('initLogger 未知级别时使用默认 DEBUG', () => {
    initLogger(undefined, 'UNKNOWN_LEVEL' as any);
    const logger = createLogger('Test');
    const writeStream = mockCreateWriteStream.mock.results[0].value;

    logger.debug('debug should appear');
    expect(writeStream.write).toHaveBeenCalled();

    // 重置为 DEBUG 级别
    initLogger(undefined, 'DEBUG');
  });

  it('logger.debug 应该输出到 stdout', () => {
    initLogger();
    const logger = createLogger('Test');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    logger.debug('debug message');

    expect(stdoutSpy).toHaveBeenCalled();
    expect(stdoutSpy.mock.calls[0][0]).toContain('debug message');

    stdoutSpy.mockRestore();
  });
});
