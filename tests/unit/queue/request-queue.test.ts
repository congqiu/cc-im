import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequestQueue } from '../../../src/queue/request-queue.js';

// Mock logger
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('RequestQueue', () => {
  let queue: RequestQueue;

  beforeEach(() => {
    queue = new RequestQueue();
  });

  it('首次入队直接运行', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const result = queue.enqueue('user1', 'conv1', 'test', execute);

    expect(result).toBe('running');
    // 等待微任务队列
    await Promise.resolve();
    expect(execute).toHaveBeenCalledWith('test');
  });

  it('相同 key 二次入队排队', async () => {
    const execute1 = vi.fn(() => new Promise(resolve => setTimeout(resolve, 100)));
    const execute2 = vi.fn().mockResolvedValue(undefined);

    const result1 = queue.enqueue('user1', 'conv1', 'test1', execute1);
    const result2 = queue.enqueue('user1', 'conv1', 'test2', execute2);

    expect(result1).toBe('running');
    expect(result2).toBe('queued');
    expect(execute2).not.toHaveBeenCalled();
  });

  it('队列满时拒绝', async () => {
    const slowExecute = vi.fn(() => new Promise(resolve => setTimeout(resolve, 1000)));
    const fastExecute = vi.fn().mockResolvedValue(undefined);

    queue.enqueue('user1', 'conv1', 'test1', slowExecute);
    queue.enqueue('user1', 'conv1', 'test2', fastExecute);
    queue.enqueue('user1', 'conv1', 'test3', fastExecute);
    queue.enqueue('user1', 'conv1', 'test4', fastExecute);
    const result = queue.enqueue('user1', 'conv1', 'test5', fastExecute);

    expect(result).toBe('rejected');
  });

  it('任务完成后自动执行下一个', async () => {
    let resolve1: () => void;
    const promise1 = new Promise<void>(r => { resolve1 = r; });
    const execute1 = vi.fn(() => promise1);
    const execute2 = vi.fn().mockResolvedValue(undefined);

    queue.enqueue('user1', 'conv1', 'test1', execute1);
    queue.enqueue('user1', 'conv1', 'test2', execute2);

    expect(execute1).toHaveBeenCalled();
    expect(execute2).not.toHaveBeenCalled();

    resolve1!();
    await promise1;
    await new Promise(resolve => setTimeout(resolve, 10)); // 等待下一个任务启动

    expect(execute2).toHaveBeenCalledWith('test2');
  });

  it('不同 convId 可并发执行', async () => {
    const execute1 = vi.fn(() => new Promise(resolve => setTimeout(resolve, 100)));
    const execute2 = vi.fn().mockResolvedValue(undefined);

    const result1 = queue.enqueue('user1', 'conv1', 'test1', execute1);
    const result2 = queue.enqueue('user1', 'conv2', 'test2', execute2);

    expect(result1).toBe('running');
    expect(result2).toBe('running');

    await Promise.resolve();
    expect(execute1).toHaveBeenCalled();
    expect(execute2).toHaveBeenCalled();
  });

  it('任务执行异常不影响后续', async () => {
    const execute1 = vi.fn().mockRejectedValue(new Error('Task 1 failed'));
    const execute2 = vi.fn().mockResolvedValue(undefined);

    queue.enqueue('user1', 'conv1', 'test1', execute1);
    queue.enqueue('user1', 'conv1', 'test2', execute2);

    await new Promise(resolve => setTimeout(resolve, 20)); // 等待任务1失败 + 任务2启动

    expect(execute2).toHaveBeenCalledWith('test2');
  });

  it('队列清空后 key 被删除', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);

    queue.enqueue('user1', 'conv1', 'test', execute);
    await new Promise(resolve => setTimeout(resolve, 10));

    // 再次入队应该是 running 而不是 queued (说明 Map 已清空)
    const result = queue.enqueue('user1', 'conv1', 'test2', execute);
    expect(result).toBe('running');
  });
});
