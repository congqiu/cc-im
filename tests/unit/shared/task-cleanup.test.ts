import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskRunState } from '../../../src/shared/claude-task.js';
import { startTaskCleanup } from '../../../src/shared/task-cleanup.js';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockTask(startedAt: number): TaskRunState {
  return {
    handle: { process: { kill: vi.fn() }, abort: vi.fn() },
    latestContent: '',
    settle: vi.fn(),
    startedAt,
  };
}

describe('startTaskCleanup', () => {
  let runningTasks: Map<string, TaskRunState>;

  beforeEach(() => {
    vi.useFakeTimers();
    runningTasks = new Map();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('清理超过 30 分钟的超时任务', () => {
    const task = createMockTask(Date.now());
    runningTasks.set('user:task1', task);

    const stop = startTaskCleanup(runningTasks);

    // 推进 30 分钟 + 1ms 使任务超时
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    // 触发清理间隔（10 分钟）
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(task.handle.abort).toHaveBeenCalled();
    expect(task.settle).toHaveBeenCalled();
    expect(runningTasks.size).toBe(0);

    stop();
  });

  it('不清理未超时的任务', () => {
    const stop = startTaskCleanup(runningTasks);

    // 在第一次清理间隔之前添加任务
    vi.advanceTimersByTime(5 * 60 * 1000);
    const task = createMockTask(Date.now());
    runningTasks.set('user:task1', task);

    // 触发清理间隔
    vi.advanceTimersByTime(10 * 60 * 1000);

    expect(task.handle.abort).not.toHaveBeenCalled();
    expect(runningTasks.size).toBe(1);

    stop();
  });

  it('只清理超时任务，保留正常任务', () => {
    const stop = startTaskCleanup(runningTasks);

    const oldTask = createMockTask(Date.now());
    runningTasks.set('user:old', oldTask);

    // 推进 25 分钟后添加新任务
    vi.advanceTimersByTime(25 * 60 * 1000);
    const newTask = createMockTask(Date.now());
    runningTasks.set('user:new', newTask);

    // 再推进 20 分钟到 t=45min，触发 t=40min 的清理周期
    // 此时 oldTask 已 45 分钟（超时），newTask 仅 20 分钟（正常）
    vi.advanceTimersByTime(20 * 60 * 1000);

    expect(oldTask.handle.abort).toHaveBeenCalled();
    expect(newTask.handle.abort).not.toHaveBeenCalled();
    expect(runningTasks.has('user:old')).toBe(false);
    expect(runningTasks.has('user:new')).toBe(true);

    stop();
  });

  it('返回的 stop 函数停止定期清理', () => {
    const task = createMockTask(Date.now());
    runningTasks.set('user:task1', task);

    const stop = startTaskCleanup(runningTasks);
    stop();

    // 推进足够时间，如果定时器还在会触发清理
    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(task.handle.abort).not.toHaveBeenCalled();
    expect(runningTasks.size).toBe(1);
  });
});
