/**
 * 共享类型定义
 */

/**
 * 话题上下文（用于飞书群聊话题和 Telegram 论坛话题）
 */
export interface ThreadContext {
  rootMessageId: string;  // 话题根消息 ID
  threadId: string;       // 话题 ID
}

/**
 * 费用记录
 */
export interface CostRecord {
  totalCost: number;
  totalDurationMs: number;
  requestCount: number;
}

/**
 * 平台无关的消息发送接口
 */
export interface MessageSender {
  sendTextReply(chatId: string, text: string, threadCtx?: ThreadContext): Promise<void>;
}
