import type { TaskRunState } from './claude-task.js';
import { TASK_TIMEOUT_MS, TASK_CLEANUP_INTERVAL_MS } from '../constants.js';
import { createLogger } from '../logger.js';

const log = createLogger('TaskCleanup');

/**
 * 启动定期任务清理（30分钟超时，每10分钟检查一次）
 * 返回停止函数
 */
export function startTaskCleanup<T extends TaskRunState>(runningTasks: Map<string, T>): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    if (runningTasks.size > 0) {
      log.info(`Running tasks: ${runningTasks.size}`);
    }
    for (const [key, task] of runningTasks) {
      const elapsedMin = ((now - task.startedAt) / 60_000).toFixed(1);
      if (now - task.startedAt > TASK_TIMEOUT_MS) {
        log.warn(`Auto-cleaning timeout task: ${key} (ran ${elapsedMin}min)`);
        task.settle();
        task.handle.abort();
        runningTasks.delete(key);
      } else {
        log.debug(`  task ${key}: running ${elapsedMin}min, content ${task.latestContent.length} chars`);
      }
    }
  }, TASK_CLEANUP_INTERVAL_MS);
  timer.unref();

  return () => clearInterval(timer);
}
