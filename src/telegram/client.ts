import { Telegraf } from 'telegraf';
import type { Config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('Telegram');

let bot: Telegraf;
let botUsername: string | undefined;

export function getBot(): Telegraf {
  if (!bot) throw new Error('Telegram bot not initialized. Call initTelegram() first.');
  return bot;
}

export function getBotUsername(): string | undefined {
  return botUsername;
}

export async function initTelegram(config: Config, setupHandlers: (bot: Telegraf) => void) {
  log.debug('Initializing Telegram bot...');
  log.debug('Bot token: configured');

  bot = new Telegraf(config.telegramBotToken);

  setupHandlers(bot);

  try {
    // 先验证 token 和网络连通性（30 秒超时）
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Telegram bot connect timeout after 30s')), 30000)
    );
    const me = await Promise.race([bot.telegram.getMe(), timeout]) as Awaited<ReturnType<typeof bot.telegram.getMe>>;
    botUsername = me.username;
    // launch() 的 Promise 在轮询停止时才 resolve，不能 await
    bot.launch().catch(err => {
      log.error('Telegram polling fatal error:', err);
      process.exit(1);
    });
    log.info('Telegram bot launched successfully');
  } catch (err) {
    log.error('Failed to launch Telegram bot:', err);
    throw err;
  }
}

export function stopTelegram() {
  log.info('Stopping Telegram bot...');
  bot?.stop('SIGTERM');
}
