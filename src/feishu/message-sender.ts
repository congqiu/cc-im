import { getClient } from './client.js';
import { buildCard, buildPermissionCard, buildPermissionResultCard, splitLongContent, type CardStatus } from './card-builder.js';
import { createLogger } from '../logger.js';

const log = createLogger('MessageSender');

export async function sendThinkingCard(chatId: string): Promise<string> {
  const client = getClient();
  // 初始创建时使用 'processing' 状态，不带停止按钮
  const res = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content: buildCard({ content: '正在启动...', status: 'processing', note: '请稍候' }), // 不传递 messageId
      msg_type: 'interactive',
    },
  });
  const messageId = res.data?.message_id ?? '';

  // 获取到真实的 message_id 后，立即更新卡片为 processing 状态并添加停止按钮
  if (messageId) {
    await updateCard(messageId, '等待 Claude 响应...', 'processing', '请稍候');
    log.debug(`Processing card created with stop button: ${messageId}`);
  }

  return messageId;
}

export async function updateCard(messageId: string, content: string, status: CardStatus, note?: string) {
  const client = getClient();
  try {
    // 只在 processing/thinking/streaming 状态时传递 messageId（用于显示停止按钮）
    const buttonMessageId = (status === 'processing' || status === 'thinking' || status === 'streaming') ? messageId : undefined;

    await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: {
        content: buildCard({ content, status, note }, buttonMessageId),
      },
    });
    log.info(`Card ${messageId} updated to status: ${status}`);
  } catch (err) {
    log.error('Failed to update card:', err);
    throw err; // 重新抛出错误以便调用方知道更新失败
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
