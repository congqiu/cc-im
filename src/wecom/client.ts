import AiBot from '@wecom/aibot-node-sdk';
import type { WSClient } from '@wecom/aibot-node-sdk';
import type { Config } from '../config.js';
import { createLogger } from '../logger.js';

export type { WSClient };

const log = createLogger('Wecom');

let wsClient: WSClient | null = null;

export function getWSClient(): WSClient {
  if (!wsClient) throw new Error('Wecom WSClient not initialized');
  return wsClient;
}

export interface WecomEventHandlerHandle {
  stop: () => void;
  getRunningTaskCount: () => number;
}

export async function initWecom(
  config: Config,
  setupHandlers: (client: WSClient) => WecomEventHandlerHandle,
): Promise<{ wsClient: WSClient; handle: WecomEventHandlerHandle }> {
  log.info('Initializing WeChat Work (WeCom) bot...');

  const client = new AiBot.WSClient({
    botId: config.wecomBotId,
    secret: config.wecomBotSecret,
    maxReconnectAttempts: -1, // 无限重连
    logger: {
      debug: (msg: string, ...args: any[]) => log.debug(`[SDK] ${msg}`, ...args),
      info: (msg: string, ...args: any[]) => log.info(`[SDK] ${msg}`, ...args),
      warn: (msg: string, ...args: any[]) => log.warn(`[SDK] ${msg}`, ...args),
      error: (msg: string, ...args: any[]) => log.error(`[SDK] ${msg}`, ...args),
    },
  });

  // 注册生命周期事件
  client.on('disconnected', (reason) => {
    log.warn(`WebSocket disconnected: ${reason}`);
  });
  client.on('reconnecting', (attempt) => {
    log.info(`Reconnecting (attempt ${attempt})...`);
  });
  client.on('error', (error) => {
    log.error('WebSocket error:', error);
  });

  // 建立连接
  client.connect();

  // 等待认证成功
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('WeChat Work authentication timed out (30s)'));
    }, 30_000);

    client.on('authenticated', () => {
      clearTimeout(timeout);
      log.info('Authenticated successfully');
      resolve();
    });
  });

  wsClient = client;

  // 设置消息处理器
  const handle = setupHandlers(client);

  return { wsClient: client, handle };
}

export function stopWecom(): void {
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
    log.info('WeChat Work bot stopped');
  }
}
