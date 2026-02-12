import { Telegraf } from 'telegraf';
import type { Config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Telegram');

let bot: Telegraf;

export function getBot(): Telegraf {
  return bot;
}

export async function initTelegram(config: Config, setupHandlers: (bot: Telegraf) => void) {
  log.debug('Initializing Telegram bot...');
  log.debug('Bot token: configured');

  bot = new Telegraf(config.telegramBotToken);

  setupHandlers(bot);

  try {
    // 添加超时保护，避免卡住
    const launchTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Telegram bot launch timeout after 30s')), 30000)
    );

    await Promise.race([
      bot.launch(),
      launchTimeout
    ]);

    log.info('Telegram bot launched successfully');
  } catch (err) {
    log.error('Failed to launch Telegram bot:', err);
    throw err; // 抛出错误而不是直接退出，让调用方决定如何处理
  }
}

export function stopTelegram() {
  log.info('Stopping Telegram bot...');
  bot?.stop('SIGTERM');
}
