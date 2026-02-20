import { createLogger } from '../logger.js';

const log = createLogger('Retry');

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 500;
  const maxDelay = opts?.maxDelayMs ?? 5000;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * 200, maxDelay);
      log.warn(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${(err as Error)?.message ?? err}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
