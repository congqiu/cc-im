import * as Lark from '@larksuiteoapi/node-sdk';
import type { Config } from '../config.js';

let client: Lark.Client;
let wsClient: Lark.WSClient;

export function getClient(): Lark.Client {
  return client;
}

export function initFeishu(config: Config, eventDispatcher: Lark.EventDispatcher) {
  const baseConfig = {
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
  };

  client = new Lark.Client(baseConfig);

  wsClient = new Lark.WSClient({
    ...baseConfig,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });

  console.log('[Feishu] WSClient started');
}
