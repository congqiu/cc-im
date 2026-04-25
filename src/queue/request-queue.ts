import { createLogger } from '../logger.js';
import { MAX_QUEUE_SIZE } from '../constants.js';

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

export interface EnqueueResult {
  status: 'running' | 'queued' | 'rejected';
  /** 排队位置（从 1 开始，仅 queued 时有值） */
  position?: number;
  /** 队列最大容量 */
  queueSize?: number;
}

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
      return { status: 'rejected', queueSize: MAX_QUEUE_SIZE };
    }

    if (queue.running) {
      queue.tasks.push({ prompt, execute, enqueuedAt: Date.now() });
      log.info(`Queued task for ${queueKey}, position: ${queue.tasks.length}/${MAX_QUEUE_SIZE}`);
      return { status: 'queued', position: queue.tasks.length, queueSize: MAX_QUEUE_SIZE };
    }

    // Not running, start immediately
    queue.running = true;
    this.run(queueKey, prompt, execute);
    return { status: 'running' };
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
