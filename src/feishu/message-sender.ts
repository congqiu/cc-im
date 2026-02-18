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
  replyCardMessage,
  streamContent as cardkitStreamContent,
  updateCardFull,
  markCompleted,
  disableStreaming,
  destroySession,
} from './cardkit-manager.js';
import { createLogger } from '../logger.js';
import type { ThreadContext } from '../shared/types.js';

export type { ThreadContext };

const log = createLogger('MessageSender');

export interface CardHandle {
  messageId: string;
  cardId: string;
}

/**
 * 获取话题描述（即话题根消息的内容）
 */
export async function fetchThreadDescription(rootMessageId: string): Promise<string | undefined> {
  const client = getClient();
  try {
    const res = await client.im.v1.message.get({
      path: { message_id: rootMessageId },
    });

    if (res.code !== 0) {
      log.warn(`Failed to fetch root message ${rootMessageId}: code=${res.code}, msg=${res.msg}`);
      return undefined;
    }

    const message = res.data?.items?.[0] ?? res.data;
    if (!message) return undefined;

    const msg = message as Record<string, unknown>;
    const msgType = msg.msg_type as string | undefined;
    const body = msg.body as Record<string, unknown> | undefined;
    const content = (body?.content ?? msg.content) as string | undefined;
    if (!content) return undefined;

    if (msgType === 'text') {
      const parsed = JSON.parse(content);
      return parsed.text || undefined;
    }
    if (msgType === 'post') {
      const parsed = JSON.parse(content);
      // 接收到的 post 结构（无 locale 包装）: { "title": "...", "content": [[{tag, text}, ...]] }
      const title = parsed.title as string | undefined;
      const paragraphs = parsed.content as Array<Array<{ tag: string; text?: string }>> | undefined;
      const bodyText = paragraphs
        ?.map((line: Array<{ tag: string; text?: string }>) => line.filter(el => el.text).map(el => el.text).join(''))
        .join('\n')
        .trim();
      return title || bodyText || undefined;
    }
    return `[${msgType}]`;
  } catch (err) {
    log.error(`Error fetching root message ${rootMessageId}:`, err);
    return undefined;
  }
}

export async function sendThinkingCard(chatId: string, threadCtx?: ThreadContext): Promise<CardHandle> {
  // 1. 创建 CardKit 卡片（初始无停止按钮）
  const initialCard = buildCardV2({ content: '正在启动...', status: 'processing', note: '请稍候' });
  const cardId = await createCard(initialCard);

  let messageId: string;

  if (threadCtx) {
    // 话题模式：用 reply API 发送到话题
    const [, result] = await Promise.all([
      enableStreaming(cardId),
      replyCardMessage(threadCtx.rootMessageId, cardId),
    ]);
    messageId = result.messageId;
  } else {
    // 非话题模式：保持现有逻辑
    const [, mid] = await Promise.all([
      enableStreaming(cardId),
      sendCardMessage(chatId, cardId),
    ]);
    messageId = mid;
  }

  // 3. 全量更新补充停止按钮（现在有 cardId 了）
  const cardWithButton = buildCardV2(
    { content: '等待 Claude 响应...', status: 'processing', note: '请稍候' },
    cardId,
  );
  await updateCardFull(cardId, cardWithButton);
  log.debug(`Processing card created: cardId=${cardId}, messageId=${messageId}`);

  return { messageId, cardId };
}

export async function streamContentUpdate(cardId: string, content: string, note?: string): Promise<void> {
  const truncated = truncateForStreaming(content) || '...';
  const updates: Promise<void>[] = [cardkitStreamContent(cardId, 'main_content', truncated)];
  if (note) updates.push(cardkitStreamContent(cardId, 'note_area', note));
  await Promise.all(updates);
}

export async function sendFinalCards(
  chatId: string,
  messageId: string,
  cardId: string,
  fullContent: string,
  note: string,
  threadCtx?: ThreadContext,
): Promise<void> {
  const parts = splitLongContent(fullContent);

  // 标记卡片为已完成，阻止 streamContent 重试重新启用 streaming
  markCompleted(cardId);

  // 显式关闭流式模式（card.update 不会自动关闭 card.settings 开启的 streaming_mode）
  await disableStreaming(cardId);

  // 更新原卡片为完成状态
  const finalCard = buildCardV2({ content: parts[0], status: 'done', note });
  await updateCardFull(cardId, finalCard);

  // 溢出部分用新消息发送
  const client = getClient();
  for (let i = 1; i < parts.length; i++) {
    const overflowCard = buildCardV2({
      content: parts[i],
      status: 'done',
      note: `(续 ${i + 1}/${parts.length}) ${note}`,
    });
    if (threadCtx) {
      await client.im.v1.message.reply({
        path: { message_id: threadCtx.rootMessageId },
        data: {
          content: overflowCard,
          msg_type: 'interactive',
          reply_in_thread: true,
        },
      });
    } else {
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: overflowCard,
          msg_type: 'interactive',
        },
      });
    }
  }

  destroySession(cardId);
}

export async function sendErrorCard(cardId: string, error: string): Promise<void> {
  markCompleted(cardId);
  await disableStreaming(cardId);
  try {
    const errorCard = buildCardV2({ content: `错误：${error}`, status: 'error', note: '执行失败' });
    await updateCardFull(cardId, errorCard);
  } catch (err) {
    log.error('Failed to send error card:', err);
  }
  destroySession(cardId);
}

export async function sendTextReply(chatId: string, text: string, threadCtx?: ThreadContext) {
  const client = getClient();
  try {
    if (threadCtx) {
      await client.im.v1.message.reply({
        path: { message_id: threadCtx.rootMessageId },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
          reply_in_thread: true,
        },
      });
    } else {
      await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    }
  } catch (err) {
    log.error('Failed to send text reply:', err);
  }
}

export async function sendPermissionCard(
  chatId: string,
  requestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  threadCtx?: ThreadContext,
): Promise<string> {
  const client = getClient();
  const content = buildPermissionCard(requestId, toolName, toolInput);
  if (threadCtx) {
    const res = await client.im.v1.message.reply({
      path: { message_id: threadCtx.rootMessageId },
      data: {
        content,
        msg_type: 'interactive',
        reply_in_thread: true,
      },
    });
    return res.data?.message_id ?? '';
  }
  const res = await client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      content,
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
