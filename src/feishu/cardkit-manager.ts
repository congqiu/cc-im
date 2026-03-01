import { getClient } from './client.js';
import { createLogger } from '../logger.js';
import { safeStringify } from '../shared/utils.js';
import { withRetry, NonRetryableError } from '../shared/retry.js';

const log = createLogger('CardKit');

interface CardSession {
  cardId: string;
  sequence: number;
  streamingEnabled: boolean;
  completed: boolean;
  createdAt: number;
  /** 连续 re-enable 失败次数，成功时重置 */
  reenableFailCount: number;
}

/** 连续 re-enable 失败上限，超过后不再尝试 */
const MAX_REENABLE_ATTEMPTS = 3;

const sessions = new Map<string, CardSession>();

// 自动清理过期会话（1小时）
const SESSION_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.createdAt > SESSION_TTL_MS) {
        sessions.delete(id);
        log.info(`Auto-cleaned expired card session: ${id}`);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

function nextSeq(cardId: string): number {
  const s = sessions.get(cardId);
  if (!s) throw new Error(`No session for card ${cardId}`);
  s.sequence += 1;
  return s.sequence;
}

/**
 * 创建 CardKit 卡片实例，初始化 session
 */
export async function createCard(cardJson: string): Promise<string> {
  ensureCleanupTimer();
  // 不使用 withRetry：创建操作不幂等，重试会产生孤儿卡片
  const client = getClient();
  const res = await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: cardJson },
  });

  const cardId = res.data?.card_id;
  if (!cardId) {
    log.error('card.create response:', safeStringify(res, 2));
    throw new Error(`card.create returned no card_id (code=${res.code}, msg=${res.msg})`);
  }

  sessions.set(cardId, { cardId, sequence: 0, streamingEnabled: false, completed: false, createdAt: Date.now(), reenableFailCount: 0 });
  log.debug(`Card created: ${cardId}`);
  return cardId;
}

/**
 * 启用流式模式
 */
export async function enableStreaming(cardId: string): Promise<void> {
  return withRetry(async () => {
    // 限频错误不再重试，避免重试风暴
    const s = sessions.get(cardId);
    if (s?.completed) return;

    const client = getClient();
    const res = await client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify({ streaming_mode: true }),
        sequence: nextSeq(cardId),
      },
    });
    if (res?.code && res.code !== 0) {
      // 限频错误不可重试，直接穿透
      if (res.code === 200400) {
        log.warn(`enableStreaming rate limited: ${res.msg}`);
        throw new NonRetryableError(`enableStreaming rate limited: code=${res.code}, msg=${res.msg}`);
      }
      log.error(`enableStreaming failed: code=${res.code}, msg=${res.msg}`);
      throw new Error(`enableStreaming error: code=${res.code}, msg=${res.msg}`);
    }
    if (s) s.streamingEnabled = true;
    log.debug(`Streaming enabled for card ${cardId}`);
  });
}

/**
 * 流式更新元素内容（打字机效果）
 */
export async function streamContent(
  cardId: string,
  elementId: string,
  content: string,
): Promise<void> {
  const client = getClient();
  const call = async (s: number) => {
    return await client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { content, sequence: s },
    });
  };

  let res;
  try {
    res = await call(nextSeq(cardId));
  } catch (err: unknown) {
    // Lark SDK 在 HTTP 4xx 时抛异常（如 99991400 平台级限频），而非返回 response 对象
    // 流式更新失败不影响功能，下次节流周期会重试
    const respData = (err as { response?: { data?: { code?: number } } })?.response?.data;
    if (respData?.code === 99991400) return; // 平台级限频，静默忽略
    log.warn(`streamContent exception: ${(err as Error)?.message ?? err}`);
    return;
  }

  const code = res?.code;

  if (!code || code === 0) {
    // 成功，重置 re-enable 失败计数
    const s = sessions.get(cardId);
    if (s) s.reenableFailCount = 0;
    return;
  }
  if (code === 200810) return;     // 用户正在交互
  if (code === 300317) return;     // sequence 冲突，下次会修正
  if (code === 200400) return;     // 限频，等下次节流重试
  if (code === 200937) return;     // 更新过于频繁，等下次节流重试
  if (code === 200740) return;     // 查询结果为空（卡片已失效），静默忽略

  // 200850 / 300309: 流式超时或已关闭 → 重新启用后重试一次
  if (code === 200850 || code === 300309) {
    const s = sessions.get(cardId);
    if (!s || s.completed) return; // 卡片已完成，不再重试
    if (s.reenableFailCount >= MAX_REENABLE_ATTEMPTS) return; // 超过上限，静默跳过
    log.warn(`Streaming closed/timeout (${code}) for card ${cardId}, re-enabling...`);
    try {
      await enableStreaming(cardId);
      // 启用后再次检查是否已完成
      const s2 = sessions.get(cardId);
      if (!s2 || s2.completed) return;
      const retryRes = await call(nextSeq(cardId));
      if (retryRes?.code && retryRes.code !== 0) {
        s.reenableFailCount++;
        log.warn(`Retry still failed: code=${retryRes.code}, skipping (${s.reenableFailCount}/${MAX_REENABLE_ATTEMPTS})`);
      } else {
        s.reenableFailCount = 0; // 重试成功，重置计数
      }
    } catch {
      s.reenableFailCount++;
      log.warn(`Re-enable failed for card ${cardId}, skipping (${s.reenableFailCount}/${MAX_REENABLE_ATTEMPTS})`);
    }
    return;
  }

  // 其他错误码
  log.error(`streamContent failed: code=${code}, msg=${res.msg}`);
}

/**
 * 全量更新卡片（完成/错误状态）
 */
export async function updateCardFull(cardId: string, cardJson: string): Promise<void> {
  return withRetry(async () => {
    const client = getClient();
    const res = await client.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: {
        card: { type: 'card_json', data: cardJson },
        sequence: nextSeq(cardId),
      },
    });
    const code = res?.code;
    if (code && code !== 0) {
      // 200810: 用户正在交互；300317: sequence 冲突（并发更新）→ 静默忽略
      if (code === 200810 || code === 300317) return;
      log.error(`updateCardFull failed: code=${code}, msg=${res.msg}`);
      throw new Error(`updateCardFull error: code=${code}, msg=${res.msg}`);
    }
    log.debug(`Card ${cardId} fully updated`);
  });
}

/**
 * 通过 card_id 发送卡片消息到聊天
 */
export async function sendCardMessage(chatId: string, cardId: string): Promise<string> {
  const client = getClient();
  const res = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      msg_type: 'interactive',
    },
  });
  const messageId = res.data?.message_id ?? '';
  log.debug(`Card message sent: messageId=${messageId}, cardId=${cardId}`);
  return messageId;
}

/**
 * 通过 reply API 将卡片发送到话题（自动创建或追加到已有话题）
 */
export async function replyCardMessage(
  rootMessageId: string,
  cardId: string,
): Promise<{ messageId: string; threadId?: string }> {
  const client = getClient();
  const res = await client.im.v1.message.reply({
    path: { message_id: rootMessageId },
    data: {
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      msg_type: 'interactive',
      reply_in_thread: true,
    },
  });
  const messageId = res.data?.message_id ?? '';
  // Lark SDK reply 返回类型未声明 thread_id 字段，但 reply_in_thread 时 API 实际会返回
  const threadId = (res.data as Record<string, unknown>)?.thread_id as string | undefined;
  log.debug(`Card replied to thread: messageId=${messageId}, rootMessageId=${rootMessageId}, threadId=${threadId}`);
  return { messageId, threadId };
}

/**
 * 关闭流式模式（必须显式调用 card.settings，card.update 不会自动关闭）
 */
export async function disableStreaming(cardId: string): Promise<void> {
  const s = sessions.get(cardId);
  if (!s || !s.streamingEnabled) return;

  // 标记已完成，防止并发调用
  s.completed = true;
  s.streamingEnabled = false;

  try {
    await withRetry(async () => {
      const client = getClient();
      const res = await client.cardkit.v1.card.settings({
        path: { card_id: cardId },
        data: {
          settings: JSON.stringify({ streaming_mode: false }),
          sequence: nextSeq(cardId),
        },
      });
      if (res?.code && res.code !== 0) {
        if (res.code === 200400) {
          throw new Error(`disableStreaming rate limited: code=${res.code}, msg=${res.msg}`);
        }
        log.warn(`disableStreaming failed: code=${res.code}, msg=${res.msg}`);
      } else {
        log.debug(`Streaming disabled for card ${cardId}`);
      }
    }, { maxRetries: 3, baseDelayMs: 500 });
  } catch (err) {
    log.warn(`disableStreaming error for card ${cardId}:`, err);
  }
}

/**
 * 标记卡片为已完成，阻止后续 streamContent 重试
 */
export function markCompleted(cardId: string): void {
  const s = sessions.get(cardId);
  if (s) s.completed = true;
}

/**
 * 清理 session 内存
 */
export function destroySession(cardId: string): void {
  sessions.delete(cardId);
  log.debug(`Session destroyed for card ${cardId}`);
}
