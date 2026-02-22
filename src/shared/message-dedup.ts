import { DEDUP_TTL_MS } from '../constants.js';

const MAX_DEDUP_SIZE = 1000;

/**
 * 消息去重器
 * 基于消息 ID 和时间戳进行去重，自动过期和大小限制
 */
export class MessageDedup {
  private processedMessages = new Map<string, number>();

  /**
   * 检查消息是否为重复消息
   * 如果是新消息，自动记录并返回 false
   * 如果是重复消息，返回 true
   */
  isDuplicate(messageId: string): boolean {
    const now = Date.now();
    if (this.processedMessages.has(messageId)) return true;
    this.processedMessages.set(messageId, now);

    // 清除过期条目（Map 保持插入顺序，遇到未过期即可停止）
    for (const [id, ts] of this.processedMessages) {
      if (now - ts > DEDUP_TTL_MS) {
        this.processedMessages.delete(id);
      } else {
        break;
      }
    }

    // 限制最大容量
    while (this.processedMessages.size > MAX_DEDUP_SIZE) {
      const oldest = this.processedMessages.keys().next().value;
      if (oldest !== undefined) this.processedMessages.delete(oldest);
      else break;
    }

    return false;
  }
}
