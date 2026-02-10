import { createLogger } from '../logger.js';

const log = createLogger('Queue');

interface QueuedTask {
  prompt: string;
  execute: (prompt: string) => Promise<void>;
}

interface UserQueue {
  running: boolean;
  tasks: QueuedTask[];
}

const MAX_QUEUE_SIZE = 3;

export type EnqueueResult = 'running' | 'queued' | 'rejected';

export class RequestQueue {
  private queues: Map<string, UserQueue> = new Map();

  /**
   * Enqueue a task for a user.
   * Returns 'running' if started immediately, 'queued' if waiting, 'rejected' if full.
   */
  enqueue(userId: string, prompt: string, execute: (prompt: string) => Promise<void>): EnqueueResult {
    let queue = this.queues.get(userId);
    if (!queue) {
      queue = { running: false, tasks: [] };
      this.queues.set(userId, queue);
    }

    if (queue.running && queue.tasks.length >= MAX_QUEUE_SIZE) {
      return 'rejected';
    }

    if (queue.running) {
      queue.tasks.push({ prompt, execute });
      log.info(`Queued task for user ${userId}, queue size: ${queue.tasks.length}`);
      return 'queued';
    }

    // Not running, start immediately
    queue.running = true;
    this.run(userId, prompt, execute);
    return 'running';
  }

  private async run(userId: string, prompt: string, execute: (prompt: string) => Promise<void>) {
    try {
      await execute(prompt);
    } catch (err) {
      log.error(`Error executing task for ${userId}:`, err);
    }

    const queue = this.queues.get(userId);
    if (!queue) return;

    const next = queue.tasks.shift();
    if (next) {
      log.info(`Processing next queued task for user ${userId}, remaining: ${queue.tasks.length}`);
      this.run(userId, next.prompt, next.execute);
    } else {
      queue.running = false;
    }
  }
}
