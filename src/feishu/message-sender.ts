import { getClient } from './client.js';
import {
  buildCardV2,
  buildPermissionCard,
  buildPermissionResultCard,
  splitLongContent,
  truncateForStreaming,
} from './card-builder.js';
import {
  createCard,
  enableStreaming,
  sendCardMessage,
  streamContent as cardkitStreamContent,
  updateCardFull,
  destroySession,
} from './cardkit-manager.js';
import { createLogger } from '../logger.js';

const log = createLogger('MessageSender');

export interface CardHandle {
  messageId: string;
  cardId: string;
}

export async function sendThinkingCard(chatId: string): Promise<CardHandle> {
  // 1. 创建 CardKit 卡片（初始无停止按钮）
  const initialCard = buildCardV2({ content: '正在启动...', status: 'processing', note: '请稍候' });
  const cardId = await createCard(initialCard);

  // 2. 并行：启用流式模式 + 发送卡片消息
  const [, messageId] = await Promise.all([
    enableStreaming(cardId),
    sendCardMessage(chatId, cardId),
  ]);

  // 3. 全量更新补充停止按钮（现在有 cardId 了）
  const cardWithButton = buildCardV2(
    { content: '等待 Claude 响应...', status: 'processing', note: '请稍候' },
    cardId,
  );
  await updateCardFull(cardId, cardWithButton);
  log.debug(`Processing card created: cardId=${cardId}, messageId=${messageId}`);

  return { messageId, cardId };
}

export async function streamContentUpdate(cardId: string, content: string): Promise<void> {
  const truncated = truncateForStreaming(content) || '...';
  await cardkitStreamContent(cardId, 'main_content', truncated);
}

export async function sendFinalCards(
  chatId: string,
  messageId: string,
  cardId: string,
  fullContent: string,
  note: string,
): Promise<void> {
  const parts = splitLongContent(fullContent);

  // 更新原卡片为完成状态
  const finalCard = buildCardV2({ content: parts[0], status: 'done', note });
  await updateCardFull(cardId, finalCard);

  // 溢出部分用新消息发送
  const client = getClient();
  for (let i = 1; i < parts.length; i++) {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: buildCardV2({
          content: parts[i],
          status: 'done',
          note: `(续 ${i + 1}/${parts.length}) ${note}`,
        }),
        msg_type: 'interactive',
      },
    });
  }

  destroySession(cardId);
}

export async function sendErrorCard(cardId: string, error: string): Promise<void> {
  try {
    const errorCard = buildCardV2({ content: `错误：${error}`, status: 'error', note: '执行失败' });
    await updateCardFull(cardId, errorCard);
  } catch (err) {
    log.error('Failed to send error card:', err);
  }
  destroySession(cardId);
}

export async function sendTextReply(chatId: string, text: string) {
  const client = getClient();
  try {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: 'text',
      },
    });
  } catch (err) {
    log.error('Failed to send text reply:', err);
  }
}

export async function sendPermissionCard(
  chatId: string,
  requestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  const client = getClient();
  const res = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: buildPermissionCard(requestId, toolName, toolInput),
      msg_type: 'interactive',
    },
  });
  return res.data?.message_id ?? '';
}

export async function updatePermissionCard(messageId: string, toolName: string, decision: 'allow' | 'deny') {
  const client = getClient();
  try {
    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: {
        content: buildPermissionResultCard(toolName, decision),
      },
    });
  } catch (err) {
    log.error('Failed to update permission card:', err);
  }
}
