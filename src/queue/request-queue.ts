import { createLogger } from '../logger.js';

const log = createLogger('Queue');

interface QueuedTask {
  prompt: string;
  execute: (prompt: string) => Promise<void>;
  enqueuedAt: number;
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
      queue.tasks.push({ prompt, execute, enqueuedAt: Date.now() });
      log.info(`Queued task for ${queueKey}, position: ${queue.tasks.length}/${MAX_QUEUE_SIZE}`);
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
      const waitSec = ((Date.now() - next.enqueuedAt) / 1000).toFixed(1);
      log.info(`Dequeuing task for ${queueKey}, waited ${waitSec}s, remaining: ${queue.tasks.length}`);
      setImmediate(() => this.run(queueKey, next.prompt, next.execute));
    } else {
      queue.running = false;
      this.queues.delete(queueKey);
    }
  }
}
