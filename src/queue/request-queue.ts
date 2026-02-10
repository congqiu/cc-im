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
   * Enqueue a task for a user's conversation.
   * Same convId tasks are serialized; different convId tasks run concurrently.
   * Returns 'running' if started immediately, 'queued' if waiting, 'rejected' if full.
   */
  enqueue(userId: string, convId: string, prompt: string, execute: (prompt: string) => Promise<void>): EnqueueResult {
    const queueKey = `${userId}:${convId}`;
    let queue = this.queues.get(queueKey);
    if (!queue) {
      queue = { running: false, tasks: [] };
      this.queues.set(queueKey, queue);
    }

    if (queue.running && queue.tasks.length >= MAX_QUEUE_SIZE) {
      return 'rejected';
    }

    if (queue.running) {
      queue.tasks.push({ prompt, execute });
      log.info(`Queued task for ${queueKey}, queue size: ${queue.tasks.length}`);
      return 'queued';
    }

    // Not running, start immediately
    queue.running = true;
    this.run(queueKey, prompt, execute);
    return 'running';
  }

  private async run(queueKey: string, prompt: string, execute: (prompt: string) => Promise<void>) {
    try {
      await execute(prompt);
    } catch (err) {
      log.error(`Error executing task for ${queueKey}:`, err);
    }

    const queue = this.queues.get(queueKey);
    if (!queue) return;

    const next = queue.tasks.shift();
    if (next) {
      log.info(`Processing next queued task for ${queueKey}, remaining: ${queue.tasks.length}`);
      this.run(queueKey, next.prompt, next.execute);
    } else {
      queue.running = false;
      this.queues.delete(queueKey);
    }
  }
}
