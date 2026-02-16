import { getBot } from './client.js';
import { createLogger } from '../logger.js';
import { splitLongContent, buildInputSummary } from '../shared/utils.js';

const log = createLogger('TgSender');

const MAX_MESSAGE_LENGTH = 4000; // Telegram limit is 4096, leave room for formatting
const MAX_RETRIES = 3;
const RATE_LIMIT_MAX_WAIT_SEC = 60; // Cap retry wait time to avoid excessive blocking
const COOLDOWN_CLEANUP_INTERVAL_MS = 3600000; // Clean up cooldown map every hour

// Per-chat rate limit cooldown tracking
const chatCooldownUntil = new Map<string, number>();

// Periodic cleanup of expired cooldown entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [chatId, until] of chatCooldownUntil.entries()) {
    if (now >= until) {
      chatCooldownUntil.delete(chatId);
    }
  }
}, COOLDOWN_CLEANUP_INTERVAL_MS);

function parseRetryAfter(err: unknown): number | null {
  if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    const match = err.message.match(/retry after (\d+)/i);
    return match ? Number(match[1]) : null;
  }
  return null;
}

function isChatCoolingDown(chatId: string): boolean {
  const until = chatCooldownUntil.get(chatId);
  if (!until) return false;
  if (Date.now() >= until) {
    chatCooldownUntil.delete(chatId);
    return false;
  }
  return true;
}

function setCooldown(chatId: string, retryAfterSec: number) {
  chatCooldownUntil.set(chatId, Date.now() + retryAfterSec * 1000);
}

/**
 * 带 429 重试的 API 调用包装器，用于必须送达的关键消息
 */
async function callWithRetry<T>(chatId: string, label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (err: unknown) {
      const retryAfter = parseRetryAfter(err);
      if (retryAfter !== null && attempt < MAX_RETRIES) {
        const waitSec = Math.min(retryAfter, RATE_LIMIT_MAX_WAIT_SEC);
        setCooldown(chatId, retryAfter);
        log.warn(`${label}: rate limited, waiting ${waitSec}s before retry (attempt ${attempt}/${MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, waitSec * 1000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

export type MessageStatus = 'thinking' | 'streaming' | 'done' | 'error';

const STATUS_ICONS: Record<MessageStatus, string> = {
  thinking: '🔵',
  streaming: '🔵',
  done: '🟢',
  error: '🔴',
};

const STATUS_TITLES: Record<MessageStatus, string> = {
  thinking: 'Claude Code - 思考中...',
  streaming: 'Claude Code',
  done: 'Claude Code',
  error: 'Claude Code - 错误',
};

function formatMessage(content: string, status: MessageStatus, note?: string): string {
  const icon = STATUS_ICONS[status];
  const title = STATUS_TITLES[status];
  let text = `${icon} ${title}\n\n${truncateForMessage(content)}`;
  if (note) {
    text += `\n\n─────────\n${note}`;
  }
  return text;
}

function truncateForMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  const keepLen = MAX_MESSAGE_LENGTH - 20;
  const tail = text.slice(text.length - keepLen);
  const lineBreak = tail.indexOf('\n');
  const clean = lineBreak > 0 && lineBreak < 200 ? tail.slice(lineBreak + 1) : tail;
  return `...(前文已省略)...\n${clean}`;
}

function buildStopKeyboard(messageId: number) {
  return {
    inline_keyboard: [[
      { text: '⏹️ 停止', callback_data: `stop_${messageId}` },
    ]],
  };
}

export async function sendThinkingMessage(chatId: string): Promise<string> {
  const bot = getBot();
  const numericChatId = Number(chatId);

  // Use retry for initial message to ensure delivery
  const msg = await callWithRetry(chatId, 'sendThinkingMessage', () =>
    bot.telegram.sendMessage(
      numericChatId,
      formatMessage('正在思考...', 'thinking', '请稍候'),
    ),
  );

  // Update with stop button now that we have the message_id
  await bot.telegram.editMessageText(
    numericChatId,
    msg.message_id,
    undefined,
    formatMessage('正在思考...', 'thinking', '请稍候'),
    { reply_markup: buildStopKeyboard(msg.message_id) },
  );
  return String(msg.message_id);
}

export async function updateMessage(chatId: string, messageId: string, content: string, status: MessageStatus, note?: string) {
  const bot = getBot();
  const isStreaming = status === 'thinking' || status === 'streaming';

  // For streaming updates, skip if chat is in cooldown to avoid hammering a rate-limited API
  if (isStreaming && isChatCoolingDown(chatId)) {
    return;
  }

  const doUpdate = () => {
    const opts: Record<string, unknown> = {};
    if (isStreaming) {
      opts.reply_markup = buildStopKeyboard(Number(messageId));
    }
    return bot.telegram.editMessageText(
      Number(chatId),
      Number(messageId),
      undefined,
      formatMessage(content, status, note),
      opts,
    );
  };

  try {
    if (isStreaming) {
      // Streaming: fire-and-forget, no retry
      await doUpdate();
    } else {
      // Critical (done/error): retry on 429
      await callWithRetry(chatId, `updateMessage(${status})`, doUpdate);
    }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
      if (err.message.includes('message is not modified')) {
        // ignore
      } else if (err.message.includes('Too Many Requests')) {
        const retryAfter = parseRetryAfter(err);
        if (retryAfter) setCooldown(chatId, retryAfter);
        if (isStreaming) {
          log.debug(`Rate limited updating message ${messageId}, cooling down for ${retryAfter ?? '?'}s`);
        } else {
          log.error(`Failed to deliver final message ${messageId} after ${MAX_RETRIES} retries (rate limited)`);
        }
      } else {
        log.error('Failed to update message:', err);
      }
    } else {
      log.error('Failed to update message:', err);
    }
  }
}

export async function sendFinalMessages(chatId: string, messageId: string, fullContent: string, note: string) {
  const parts = splitLongContent(fullContent, MAX_MESSAGE_LENGTH);

  // Update the original message with the first part
  await updateMessage(chatId, messageId, parts[0], 'done', note);

  // Send continuation messages for remaining parts
  const bot = getBot();
  const numericChatId = Number(chatId);
  for (let i = 1; i < parts.length; i++) {
    try {
      await callWithRetry(chatId, `sendFinalMessages(part ${i + 1}/${parts.length})`, () =>
        bot.telegram.sendMessage(
          numericChatId,
          formatMessage(parts[i], 'done', `(续 ${i + 1}/${parts.length}) ${note}`),
        ),
      );
    } catch (err) {
      log.error(`Failed to send continuation part ${i + 1}/${parts.length}:`, err);
    }
  }
}

export async function sendTextReply(chatId: string, text: string) {
  const bot = getBot();
  try {
    await bot.telegram.sendMessage(Number(chatId), text);
  } catch (err) {
    log.error('Failed to send text reply:', err);
  }
}

export async function sendPermissionMessage(
  chatId: string,
  requestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string> {
  const bot = getBot();

  const inputSummary = buildInputSummary(toolName, toolInput);

  const text = `🔐 权限确认 - ${toolName}\n\n${truncateForMessage(inputSummary)}\n\n─────────\nID: ${requestId} | 回复 /allow 允许 · /deny 拒绝`;

  const msg = await callWithRetry(chatId, 'sendPermissionMessage', () =>
    bot.telegram.sendMessage(Number(chatId), text),
  );
  return String(msg.message_id);
}

export async function updatePermissionMessage(chatId: string, messageId: string, toolName: string, decision: 'allow' | 'deny') {
  const bot = getBot();
  const isAllowed = decision === 'allow';
  const icon = isAllowed ? '✅' : '❌';
  const text = `🔐 ${toolName} - ${isAllowed ? '已允许 ✓' : '已拒绝 ✗'}\n\n${icon} ${isAllowed ? '操作已允许执行。' : '操作已被拒绝。'}`;

  try {
    await callWithRetry(chatId, 'updatePermissionMessage', () =>
      bot.telegram.editMessageText(Number(chatId), Number(messageId), undefined, text),
    );
  } catch (err) {
    log.error('Failed to update permission message:', err);
  }
}

