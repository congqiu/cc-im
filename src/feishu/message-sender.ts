import { getClient } from './client.js';
import { buildCard, buildPermissionCard, buildPermissionResultCard, splitLongContent, type CardStatus } from './card-builder.js';
import { createLogger } from '../logger.js';

const log = createLogger('MessageSender');

export async function sendThinkingCard(chatId: string): Promise<string> {
  const client = getClient();
  const res = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: buildCard({ content: '正在思考...', status: 'thinking', note: '请稍候' }, 'pending'),
      msg_type: 'interactive',
    },
  });
  const messageId = res.data?.message_id ?? '';

  // 获取到真实的 message_id 后，更新卡片以包含正确的停止按钮
  if (messageId) {
    await updateCard(messageId, '正在思考...', 'thinking', '请稍候');
  }

  return messageId;
}

export async function updateCard(messageId: string, content: string, status: CardStatus, note?: string) {
  const client = getClient();
  try {
    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: {
        content: buildCard({ content, status, note }, messageId),
      },
    });
  } catch (err) {
    log.error('Failed to update card:', err);
  }
}

export async function sendFinalCards(chatId: string, messageId: string, fullContent: string, note: string) {
  const parts = splitLongContent(fullContent);

  // Update the original card with the first part
  await updateCard(messageId, parts[0], 'done', note);

  // Send continuation cards for remaining parts
  const client = getClient();
  for (let i = 1; i < parts.length; i++) {
    await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        content: buildCard({
          content: parts[i],
          status: 'done',
          note: `(续 ${i + 1}/${parts.length}) ${note}`,
        }),
        msg_type: 'interactive',
      },
    });
  }
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
