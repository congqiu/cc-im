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
    await bot.launch();
    log.info('Telegram bot launched successfully');
  } catch (err) {
    log.error('Failed to launch Telegram bot:', err);
    process.exit(1);
  }
}

export function stopTelegram() {
  log.info('Stopping Telegram bot...');
  bot?.stop('SIGTERM');
}
