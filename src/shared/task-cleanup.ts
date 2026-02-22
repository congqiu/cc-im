import type { TaskRunState } from './claude-task.js';
import { createLogger } from '../logger.js';

const log = createLogger('TaskCleanup');

const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const TASK_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 启动定期任务清理（30分钟超时，每10分钟检查一次）
 * 返回停止函数
 */
export function startTaskCleanup<T extends TaskRunState>(runningTasks: Map<string, T>): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, task] of runningTasks) {
      if (now - task.startedAt > TASK_TIMEOUT_MS) {
        log.warn(`Auto-cleaning timeout task: ${key}`);
        task.handle.abort();
        task.settle();
        runningTasks.delete(key);
      }
    }
  }, TASK_CLEANUP_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
