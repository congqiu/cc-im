import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, NonRetryableError } from '../../../src/shared/retry.js';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('成功时直接返回结果', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('失败后重试直到成功', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { baseDelayMs: 100, maxDelayMs: 1000 });

    // 第一次重试延迟
    await vi.advanceTimersByTimeAsync(400);
    // 第二次重试延迟
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('超过最大重试次数后抛出最后的错误', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new Error('always fail'));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 20 }),
    ).rejects.toThrow('always fail');
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    vi.useFakeTimers();
  });

  it('延迟不超过 maxDelayMs', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { baseDelayMs: 10000, maxDelayMs: 100 });

    // maxDelayMs=100, 所以延迟不会超过 100+200=300ms
    await vi.advanceTimersByTimeAsync(400);

    const result = await promise;
    expect(result).toBe('ok');
  });

  it('使用默认参数', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn);
    await vi.advanceTimersByTimeAsync(1000);

    const result = await promise;
    expect(result).toBe('ok');
  });

  it('NonRetryableError 直接抛出不重试', async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError('rate limited'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 20 }),
    ).rejects.toThrow('rate limited');
    expect(fn).toHaveBeenCalledTimes(1); // 不重试，只调用 1 次
  });

  it('NonRetryableError 保留 instanceof 检查', () => {
    const err = new NonRetryableError('test');
    expect(err).toBeInstanceOf(NonRetryableError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NonRetryableError');
  });

  it('shouldRetry 返回 false 时不重试', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('custom error'));

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 20,
        shouldRetry: (err) => !(err instanceof Error && err.message === 'custom error'),
      }),
    ).rejects.toThrow('custom error');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('shouldRetry 返回 true 时正常重试', async () => {
    vi.useRealTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 20,
      shouldRetry: () => true,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
  });

  it('NonRetryableError 优先于 shouldRetry', async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError('non-retryable'));

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        maxDelayMs: 20,
        shouldRetry: () => true,
      }),
    ).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
