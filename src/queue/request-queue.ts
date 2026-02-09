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

export class RequestQueue {
  private queues: Map<string, UserQueue> = new Map();

  /**
   * Enqueue a task for a user. Returns false if the queue is full.
   */
  enqueue(userId: string, prompt: string, execute: (prompt: string) => Promise<void>): boolean {
    let queue = this.queues.get(userId);
    if (!queue) {
      queue = { running: false, tasks: [] };
      this.queues.set(userId, queue);
    }

    if (queue.running && queue.tasks.length >= MAX_QUEUE_SIZE) {
      return false;
    }

    if (queue.running) {
      queue.tasks.push({ prompt, execute });
      log.info(`Queued task for user ${userId}, queue size: ${queue.tasks.length}`);
      return true;
    }

    // Not running, start immediately
    queue.running = true;
    this.run(userId, prompt, execute);
    return true;
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
