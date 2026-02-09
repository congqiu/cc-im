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
      console.error(`[Queue] Error executing task for ${userId}:`, err);
    }

    const queue = this.queues.get(userId);
    if (!queue) return;

    const next = queue.tasks.shift();
    if (next) {
      this.run(userId, next.prompt, next.execute);
    } else {
      queue.running = false;
    }
  }
}
