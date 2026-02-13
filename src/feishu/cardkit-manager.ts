import { getClient } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('CardKit');

interface CardSession {
  cardId: string;
  sequence: number;
  streamingEnabled: boolean;
}

const sessions = new Map<string, CardSession>();

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
  const client = getClient();
  const res = await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: cardJson },
  });

  const cardId = res.data?.card_id;
  if (!cardId) {
    log.error('card.create response:', JSON.stringify(res, null, 2));
    throw new Error(`card.create returned no card_id (code=${res.code}, msg=${res.msg})`);
  }

  sessions.set(cardId, { cardId, sequence: 0, streamingEnabled: false });
  log.debug(`Card created: ${cardId}`);
  return cardId;
}

/**
 * 启用流式模式
 */
export async function enableStreaming(cardId: string): Promise<void> {
  const client = getClient();
  const res = await client.cardkit.v1.card.settings({
    path: { card_id: cardId },
    data: {
      settings: JSON.stringify({ streaming_mode: true }),
      sequence: nextSeq(cardId),
    },
  });
  if (res?.code && res.code !== 0) {
    log.error(`enableStreaming failed: code=${res.code}, msg=${res.msg}`);
    throw new Error(`enableStreaming error: code=${res.code}, msg=${res.msg}`);
  }
  const s = sessions.get(cardId);
  if (s) s.streamingEnabled = true;
  log.debug(`Streaming enabled for card ${cardId}`);
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

  const res = await call(nextSeq(cardId));
  const code = res?.code;

  if (!code || code === 0) return; // 成功
  if (code === 200810) return;     // 用户正在交互
  if (code === 300317) return;     // sequence 冲突，下次会修正
  if (code === 200400) return;     // 限频，等下次节流重试

  // 200850 / 300309: 流式超时或已关闭 → 重新启用后重试一次
  if (code === 200850 || code === 300309) {
    log.warn(`Streaming closed/timeout (${code}) for card ${cardId}, re-enabling...`);
    try {
      await enableStreaming(cardId);
      const retryRes = await call(nextSeq(cardId));
      if (retryRes?.code && retryRes.code !== 0) {
        log.warn(`Retry still failed: code=${retryRes.code}, skipping`);
      }
    } catch {
      log.warn(`Re-enable failed for card ${cardId}, skipping`);
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
    // 200810: 用户正在交互，静默忽略
    if (code === 200810) return;
    log.error(`updateCardFull failed: code=${code}, msg=${res.msg}`);
    throw new Error(`updateCardFull error: code=${code}, msg=${res.msg}`);
  }
  log.debug(`Card ${cardId} fully updated`);
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
 * 清理 session 内存
 */
export function destroySession(cardId: string): void {
  sessions.delete(cardId);
  log.debug(`Session destroyed for card ${cardId}`);
}
