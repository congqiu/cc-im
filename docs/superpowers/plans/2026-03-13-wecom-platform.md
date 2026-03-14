# 企业微信平台适配实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 cc-im 新增企业微信（WeCom）平台支持，使用 `@wecom/aibot-node-sdk` WebSocket 长连接接入，支持私聊、群聊、流式回复、权限确认和停止功能。

**Architecture:** 新增 `src/wecom/` 目录（client.ts、event-handler.ts、message-sender.ts），遵循 Telegram 平台的实现模式。复用共享层（SessionManager、RequestQueue、CommandHandler、ClaudeTask）。流式输出使用 SDK 原生 `replyStream()` 配合 6 分钟自动续接。权限确认使用 `sendMessage()` 主动推送模板卡片。

**Tech Stack:** TypeScript ESM, `@wecom/aibot-node-sdk` ^1.0.1, vitest

**Spec:** `docs/superpowers/specs/2026-03-13-wecom-platform-design.md`

---

## Chunk 1: 基础设施（配置、常量、依赖）

### Task 1: 安装依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 @wecom/aibot-node-sdk**

```bash
pnpm add @wecom/aibot-node-sdk
```

- [ ] **Step 2: 确认安装成功**

```bash
pnpm list @wecom/aibot-node-sdk
```

Expected: 显示 `@wecom/aibot-node-sdk 1.0.1`

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: 添加 @wecom/aibot-node-sdk 依赖"
```

---

### Task 2: 扩展 Platform 类型和配置

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: 写配置测试**

在 `tests/unit/config.test.ts` 中追加测试。先阅读现有测试文件了解测试模式，然后在文件末尾追加：

```typescript
describe('wecom platform detection', () => {
  it('should detect wecom when WECOM_BOT_ID and WECOM_BOT_SECRET are set', () => {
    process.env.WECOM_BOT_ID = 'test-bot-id';
    process.env.WECOM_BOT_SECRET = 'test-bot-secret';
    const config = loadConfig();
    expect(config.enabledPlatforms).toContain('wecom');
    expect(config.wecomBotId).toBe('test-bot-id');
    expect(config.wecomBotSecret).toBe('test-bot-secret');
  });

  it('should not detect wecom when only WECOM_BOT_ID is set', () => {
    process.env.WECOM_BOT_ID = 'test-bot-id';
    delete process.env.WECOM_BOT_SECRET;
    // 需要另一个平台配置才不会抛异常
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    const config = loadConfig();
    expect(config.enabledPlatforms).not.toContain('wecom');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- tests/unit/config.test.ts
```

Expected: FAIL — `wecomBotId` 不存在于 Config 类型

- [ ] **Step 3: 修改 src/config.ts**

3a. 扩展 `Platform` 类型（第 11 行）：

```typescript
export type Platform = 'feishu' | 'telegram' | 'wecom';
```

3b. 在 `Config` 接口中追加字段（第 17 行 `telegramBotToken` 后面）：

```typescript
  wecomBotId: string;
  wecomBotSecret: string;
```

3c. 在 `FileConfig` 接口中追加可选字段（第 33 行 `telegramBotToken?` 后面）：

```typescript
  wecomBotId?: string;
  wecomBotSecret?: string;
```

3d. 在 `detectPlatforms()` 函数中，飞书检测代码块之后（第 84 行后），添加企业微信检测：

```typescript
  // 检测企业微信
  const wecomBotId = process.env.WECOM_BOT_ID ?? file.wecomBotId;
  const wecomBotSecret = process.env.WECOM_BOT_SECRET ?? file.wecomBotSecret;
  if (wecomBotId && wecomBotSecret) {
    platforms.push('wecom');
  }
```

3e. 更新无平台错误信息（第 88-92 行）：

```typescript
    throw new Error(
      '至少需要配置一个平台：\n' +
      '  Telegram: 设置 TELEGRAM_BOT_TOKEN\n' +
      '  飞书: 设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET\n' +
      '  企业微信: 设置 WECOM_BOT_ID 和 WECOM_BOT_SECRET'
    );
```

3f. 在 `loadConfig()` 返回对象中，`telegramBotToken` 后面添加：

```typescript
    // 企业微信配置
    wecomBotId: process.env.WECOM_BOT_ID ?? file.wecomBotId ?? '',
    wecomBotSecret: process.env.WECOM_BOT_SECRET ?? file.wecomBotSecret ?? '',
```

（在第 107 行 `telegramBotToken` 之后，第 109 行 `allowedUserIds` 之前）

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- tests/unit/config.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/unit/config.test.ts
git commit -m "feat: 扩展 Platform 类型和配置支持企业微信"
```

---

### Task 3: 新增企业微信常量

**Files:**
- Modify: `src/constants.ts`

- [ ] **Step 1: 在 `src/constants.ts` 末尾追加常量**

在文件末尾（第 108 行 `} as const;` 之后）追加：

```typescript

/**
 * 企业微信流式更新节流时间（毫秒）
 */
export const WECOM_THROTTLE_MS = 200;

/**
 * 企业微信流式消息续接阈值（毫秒）
 * 企业微信流式消息有 6 分钟硬超时，设 5 分 30 秒触发续接
 */
export const WECOM_STREAM_TIMEOUT_MS = 330_000;

/**
 * 企业微信消息最大长度
 * replyStream 的 content 最长不超过 20480 字节（utf-8）
 * 为安全起见，以字符计限制在 4000
 */
export const MAX_WECOM_MESSAGE_LENGTH = 4000;
```

- [ ] **Step 2: 确认构建通过**

```bash
pnpm build
```

Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat: 新增企业微信相关常量"
```

---

### Task 4: 扩展 active-chats 支持企业微信

**Files:**
- Modify: `src/shared/active-chats.ts`

- [ ] **Step 1: 修改 active-chats.ts**

4a. 修改 `ActiveChatsData` 接口（第 12-15 行），添加 `wecom`：

```typescript
interface ActiveChatsData {
  feishu?: string;
  telegram?: string;
  wecom?: string;
}
```

4b. 修改 `getActiveChatId` 和 `setActiveChatId` 的 platform 参数类型（第 44 行和第 48 行）：

将 `platform: 'feishu' | 'telegram'` 改为 `platform: 'feishu' | 'telegram' | 'wecom'`

- [ ] **Step 2: 确认构建通过**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/active-chats.ts
git commit -m "feat: active-chats 支持企业微信平台"
```

---

### Task 5: 扩展 CommandHandler 的 platform 类型

**Files:**
- Modify: `src/commands/handler.ts`

- [ ] **Step 1: 修改 dispatch() 的 platform 参数类型**

第 60 行，将 `platform: 'feishu' | 'telegram'` 改为使用 `Platform` 类型（从 `../config.js` 导入）：

```typescript
    platform: Platform,
```

- [ ] **Step 2: 修改 handleHelp() 的 platform 参数类型**

第 116 行，同样改为 `Platform` 类型：

```typescript
  async handleHelp(chatId: string, platform: Platform, threadCtx?: ThreadContext): Promise<boolean> {
```

在 help 文本中，`threadsCmd` 之后（第 134 行后），添加企业微信专有命令提示：

```typescript
    const stopCmd = platform === 'wecom' ? '/stop           - 停止当前运行的任务\n' : '';
```

然后在 helpText 数组中 `threadsCmd` 行之后插入 `stopCmd`。

- [ ] **Step 3: 确认构建通过**

```bash
pnpm build
```

- [ ] **Step 4: 运行现有命令处理器测试**

```bash
pnpm test -- tests/unit/commands/handler.test.ts
```

Expected: PASS（现有测试不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/commands/handler.ts
git commit -m "feat: CommandHandler 支持 wecom 平台类型"
```

---

## Chunk 2: 企业微信客户端模块

### Task 6: 创建 src/wecom/client.ts

**Files:**
- Create: `src/wecom/client.ts`
- Test: `tests/unit/wecom/client.test.ts`

- [ ] **Step 1: 写测试**

创建 `tests/unit/wecom/client.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @wecom/aibot-node-sdk
vi.mock('@wecom/aibot-node-sdk', () => {
  const EventEmitter = require('eventemitter3');
  class MockWSClient extends EventEmitter {
    connect() {
      // 模拟异步认证成功
      setTimeout(() => this.emit('authenticated'), 10);
      return this;
    }
    disconnect() {}
    get isConnected() { return true; }
  }
  return {
    default: { WSClient: MockWSClient },
    generateReqId: (prefix: string) => `${prefix}_test_${Date.now()}`,
  };
});

describe('wecom client', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('should export initWecom and stopWecom', async () => {
    const { initWecom, stopWecom } = await import('../../../src/wecom/client.js');
    expect(typeof initWecom).toBe('function');
    expect(typeof stopWecom).toBe('function');
  });

  it('should initialize and authenticate', async () => {
    const { initWecom } = await import('../../../src/wecom/client.js');
    const mockConfig = {
      wecomBotId: 'test-bot-id',
      wecomBotSecret: 'test-secret',
    } as any;

    const mockHandler = { stop: vi.fn(), getRunningTaskCount: vi.fn(() => 0) };
    const setupHandlers = vi.fn(() => mockHandler);

    const result = await initWecom(mockConfig, setupHandlers);
    expect(result.wsClient).toBeDefined();
    expect(result.handle).toBe(mockHandler);
    expect(setupHandlers).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- tests/unit/wecom/client.test.ts
```

Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 src/wecom/client.ts**

```typescript
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
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- tests/unit/wecom/client.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wecom/client.ts tests/unit/wecom/client.test.ts
git commit -m "feat: 企业微信客户端连接管理模块"
```

---

## Chunk 3: 消息发送模块

### Task 7: 创建 src/wecom/message-sender.ts

**Files:**
- Create: `src/wecom/message-sender.ts`
- Test: `tests/unit/wecom/message-sender.test.ts`

- [ ] **Step 1: 写测试**

创建 `tests/unit/wecom/message-sender.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WSClient, WsFrame } from '@wecom/aibot-node-sdk';

function createMockWSClient(): WSClient {
  return {
    replyStream: vi.fn().mockResolvedValue({ headers: { req_id: 'r1' } }),
    replyStreamWithCard: vi.fn().mockResolvedValue({ headers: { req_id: 'r1' } }),
    sendMessage: vi.fn().mockResolvedValue({ headers: { req_id: 'r2' } }),
    updateTemplateCard: vi.fn().mockResolvedValue({ headers: { req_id: 'r3' } }),
    downloadFile: vi.fn().mockResolvedValue({ buffer: Buffer.from('test'), filename: 'test.jpg' }),
    isConnected: true,
  } as unknown as WSClient;
}

function createMockFrame(): WsFrame {
  return { headers: { req_id: 'test-req-id' } } as WsFrame;
}

describe('wecom message-sender', () => {
  let mockClient: WSClient;

  beforeEach(() => {
    mockClient = createMockWSClient();
  });

  it('should export sendTextReply', async () => {
    const { createWecomSender } = await import('../../../src/wecom/message-sender.js');
    const sender = createWecomSender(mockClient);
    expect(typeof sender.sendTextReply).toBe('function');
  });

  it('sendTextReply should use sendMessage with markdown', async () => {
    const { createWecomSender } = await import('../../../src/wecom/message-sender.js');
    const sender = createWecomSender(mockClient);
    await sender.sendTextReply('chat1', 'hello');
    expect(mockClient.sendMessage).toHaveBeenCalledWith('chat1', {
      msgtype: 'markdown',
      markdown: { content: 'hello' },
    });
  });

  it('sendPermissionCard should use sendMessage with template_card', async () => {
    const { createWecomSender } = await import('../../../src/wecom/message-sender.js');
    const sender = createWecomSender(mockClient);
    const msgId = await sender.sendPermissionCard('chat1', 'req1', 'Bash', { command: 'ls' });
    expect(mockClient.sendMessage).toHaveBeenCalled();
    const call = (mockClient.sendMessage as any).mock.calls[0];
    expect(call[0]).toBe('chat1');
    expect(call[1].msgtype).toBe('template_card');
    expect(call[1].template_card.button_list).toHaveLength(2);
  });

  it('sendStreamUpdate should call replyStream', async () => {
    const { createWecomSender } = await import('../../../src/wecom/message-sender.js');
    const sender = createWecomSender(mockClient);
    const frame = createMockFrame();
    sender.initStream(frame);
    await sender.sendStreamUpdate('hello world');
    expect(mockClient.replyStreamWithCard || mockClient.replyStream).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- tests/unit/wecom/message-sender.test.ts
```

Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 src/wecom/message-sender.ts**

```typescript
import type { WSClient, WsFrame, WsFrameHeaders, TemplateCard } from '@wecom/aibot-node-sdk';
import { generateReqId } from '@wecom/aibot-node-sdk';
import { createLogger } from '../logger.js';
import { splitLongContent, buildInputSummary, truncateText } from '../shared/utils.js';
import { MAX_WECOM_MESSAGE_LENGTH, WECOM_STREAM_TIMEOUT_MS } from '../constants.js';
import type { PermissionSender } from '../hook/permission-server.js';
import type { MessageSender } from '../commands/handler.js';

const log = createLogger('WecomSender');

/**
 * 流式会话状态
 */
interface StreamSession {
  frame: WsFrame;
  chatId: string | null;
  streamId: string;
  streamStartedAt: number;
  isFirstUpdate: boolean;
  taskKey: string;
}

export interface WecomSender extends MessageSender {
  /** 初始化流式会话 */
  initStream(frame: WsFrame, taskKey?: string): void;
  /** 流式更新内容 */
  sendStreamUpdate(content: string, toolNote?: string): Promise<void>;
  /** 思考→文本切换时重置 stream */
  resetStreamForTextSwitch(content: string): Promise<void>;
  /** 完成流式输出 */
  sendStreamComplete(content: string, note: string): Promise<void>;
  /** 发送错误 */
  sendStreamError(error: string): Promise<void>;
  /** 清理 stream 状态 */
  cleanupStream(): void;
  /** 权限相关 */
  sendPermissionCard(chatId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>): Promise<string>;
  updatePermissionCard(params: { messageId: string; chatId: string; toolName: string; decision: 'allow' | 'deny' }): Promise<void>;
  /** 发送图片 */
  sendImage(chatId: string, imagePath: string): Promise<void>;
}

function buildStopCard(taskKey: string): TemplateCard {
  return {
    card_type: 'button_interaction',
    main_title: { title: 'Claude Code' },
    button_list: [
      { text: '⏹️ 停止', style: 2, key: `stop_${taskKey}` },
    ],
    task_id: `stop_${taskKey}_${Date.now()}`,
  };
}

function buildPermissionCard(requestId: string, toolName: string, inputSummary: string): TemplateCard {
  return {
    card_type: 'button_interaction',
    main_title: { title: `权限确认: ${toolName}` },
    sub_title_text: truncateText(inputSummary, 200),
    button_list: [
      { text: '✅ 允许', style: 1, key: `perm_allow_${requestId}` },
      { text: '❌ 拒绝', style: 2, key: `perm_deny_${requestId}` },
    ],
    task_id: requestId,
  };
}

export function createWecomSender(wsClient: WSClient): WecomSender {
  let session: StreamSession | null = null;

  function initStream(frame: WsFrame, taskKey?: string): void {
    const body = frame.body as Record<string, any> | undefined;
    session = {
      frame,
      chatId: body?.chatid ?? body?.from?.userid ?? null,
      streamId: generateReqId('stream'),
      streamStartedAt: Date.now(),
      isFirstUpdate: true,
      taskKey: taskKey ?? '',
    };
  }

  /**
   * 检查是否需要续接（接近 5 分 30 秒时触发）
   */
  async function renewStreamIfNeeded(content: string): Promise<void> {
    if (!session) return;
    const elapsed = Date.now() - session.streamStartedAt;
    if (elapsed < WECOM_STREAM_TIMEOUT_MS) return;

    log.info(`Stream timeout approaching (${Math.round(elapsed / 1000)}s), renewing...`);
    try {
      // 结束当前 stream
      await wsClient.replyStream(session.frame, session.streamId, content, true);
    } catch (err) {
      log.warn('Failed to finish current stream during renewal:', err);
    }
    // 创建新 stream
    session.streamId = generateReqId('stream');
    session.streamStartedAt = Date.now();
    session.isFirstUpdate = true;
    try {
      await wsClient.replyStream(session.frame, session.streamId, '', false);
    } catch (err) {
      log.error('Failed to start new stream after renewal:', err);
    }
  }

  async function sendStreamUpdate(content: string, toolNote?: string): Promise<void> {
    if (!session) return;
    await renewStreamIfNeeded(content);

    const displayContent = toolNote
      ? `${content}\n\n─────────\n输出中...\n${toolNote}`
      : content;

    try {
      if (session.isFirstUpdate) {
        session.isFirstUpdate = false;
        if (session.taskKey) {
          await wsClient.replyStreamWithCard(
            session.frame, session.streamId, displayContent, false,
            { templateCard: buildStopCard(session.taskKey) },
          );
        } else {
          await wsClient.replyStream(session.frame, session.streamId, displayContent, false);
        }
      } else {
        await wsClient.replyStream(session.frame, session.streamId, displayContent, false);
      }
    } catch (err) {
      log.warn('Failed to send stream update:', err);
    }
  }

  async function resetStreamForTextSwitch(content: string): Promise<void> {
    if (!session) return;
    // 结束思考阶段的 stream
    try {
      await wsClient.replyStream(session.frame, session.streamId, '', true);
    } catch (err) {
      log.warn('Failed to finish thinking stream:', err);
    }
    // 开始新的 stream
    session.streamId = generateReqId('stream');
    session.streamStartedAt = Date.now();
    session.isFirstUpdate = true;
  }

  async function sendStreamComplete(content: string, note: string): Promise<void> {
    if (!session) return;
    const parts = splitLongContent(content, MAX_WECOM_MESSAGE_LENGTH);
    const firstPart = parts[0] + (note ? `\n\n─────────\n${note}` : '');

    try {
      await wsClient.replyStream(session.frame, session.streamId, firstPart, true);
    } catch (err) {
      log.error('Failed to finish stream:', err);
      // 降级：尝试 sendMessage
      try {
        const chatId = session.chatId;
        if (chatId) {
          await wsClient.sendMessage(chatId, {
            msgtype: 'markdown',
            markdown: { content: firstPart },
          });
        }
      } catch (fallbackErr) {
        log.error('Fallback sendMessage also failed:', fallbackErr);
      }
    }

    // 发送续片
    for (let i = 1; i < parts.length; i++) {
      try {
        const chatId = session.chatId;
        if (chatId) {
          await wsClient.sendMessage(chatId, {
            msgtype: 'markdown',
            markdown: { content: `(续 ${i + 1}/${parts.length})\n\n${parts[i]}` },
          });
        }
      } catch (err) {
        log.error(`Failed to send continuation part ${i + 1}/${parts.length}:`, err);
      }
    }
    session = null;
  }

  async function sendStreamError(error: string): Promise<void> {
    if (!session) return;
    try {
      await wsClient.replyStream(session.frame, session.streamId, `错误：${error}`, true);
    } catch (err) {
      log.error('Failed to send error stream:', err);
    }
    session = null;
  }

  function cleanupStream(): void {
    session = null;
  }

  async function sendTextReply(chatId: string, text: string): Promise<void> {
    try {
      await wsClient.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content: text },
      });
    } catch (err) {
      log.error('Failed to send text reply:', err);
    }
  }

  async function sendPermissionCard(
    chatId: string,
    requestId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<string> {
    const inputSummary = buildInputSummary(toolName, toolInput);
    const card = buildPermissionCard(requestId, toolName, inputSummary);
    const result = await wsClient.sendMessage(chatId, {
      msgtype: 'template_card',
      template_card: card,
    });
    return result?.headers?.req_id ?? `wecom-perm-${Date.now()}`;
  }

  async function updatePermissionCard(params: {
    messageId: string;
    chatId: string;
    toolName: string;
    decision: 'allow' | 'deny';
  }): Promise<void> {
    // 注意：updateTemplateCard 需要事件帧的 req_id，
    // 这里通过 event.template_card_event 事件处理器直接调用
    // messageId 在这个场景下用作日志标识
    log.debug(`Permission card updated: ${params.toolName} -> ${params.decision} (msgId=${params.messageId})`);
  }

  async function sendImage(chatId: string, imagePath: string): Promise<void> {
    // 企业微信不支持独立发送图片消息
    // 图片只能在 replyStream finish 时通过 msgItem 附带
    log.debug(`Image sending not supported as standalone message, path: ${imagePath}`);
  }

  return {
    sendTextReply,
    initStream,
    sendStreamUpdate,
    resetStreamForTextSwitch,
    sendStreamComplete,
    sendStreamError,
    cleanupStream,
    sendPermissionCard,
    updatePermissionCard,
    sendImage,
  };
}

// chatId 在 initStream() 时已从 frame.body 中提取并缓存到 session.chatId
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- tests/unit/wecom/message-sender.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wecom/message-sender.ts tests/unit/wecom/message-sender.test.ts
git commit -m "feat: 企业微信消息发送模块（流式回复、权限卡片、分片）"
```

---

## Chunk 4: 事件处理模块

### Task 8: 创建 src/wecom/event-handler.ts

**Files:**
- Create: `src/wecom/event-handler.ts`
- Test: `tests/unit/wecom/event-handler.test.ts`

- [ ] **Step 1: 写测试**

创建 `tests/unit/wecom/event-handler.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import EventEmitter from 'eventemitter3';

// Mock 依赖
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

vi.mock('../../../src/hook/permission-server.js', () => ({
  registerPermissionSender: vi.fn(),
  resolvePermissionById: vi.fn(),
}));

vi.mock('../../../src/shared/task-cleanup.js', () => ({
  startTaskCleanup: vi.fn(() => vi.fn()),
}));

vi.mock('../../../src/shared/active-chats.js', () => ({
  setActiveChatId: vi.fn(),
}));

vi.mock('../../../src/shared/claude-task.js', () => ({
  runClaudeTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/wecom/message-sender.js', () => ({
  createWecomSender: vi.fn(() => ({
    sendTextReply: vi.fn().mockResolvedValue(undefined),
    initStream: vi.fn(),
    sendStreamUpdate: vi.fn(),
    resetStreamForTextSwitch: vi.fn(),
    sendStreamComplete: vi.fn().mockResolvedValue(undefined),
    sendStreamError: vi.fn().mockResolvedValue(undefined),
    cleanupStream: vi.fn(),
    sendPermissionCard: vi.fn().mockResolvedValue('msg-id'),
    updatePermissionCard: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('wecom event-handler', () => {
  it('should export setupWecomHandlers', async () => {
    const { setupWecomHandlers } = await import('../../../src/wecom/event-handler.js');
    expect(typeof setupWecomHandlers).toBe('function');
  });

  it('should return handle with stop and getRunningTaskCount', async () => {
    const { setupWecomHandlers } = await import('../../../src/wecom/event-handler.js');
    const mockClient = new EventEmitter() as any;
    mockClient.on = vi.fn(mockClient.on.bind(mockClient));
    mockClient.downloadFile = vi.fn();
    mockClient.updateTemplateCard = vi.fn();

    const mockConfig = {
      allowedUserIds: [],
      claudeWorkDir: '/tmp',
      allowedBaseDirs: ['/tmp'],
      claudeSkipPermissions: false,
      claudeCliPath: 'claude',
      claudeTimeoutMs: 600000,
    } as any;

    const { SessionManager } = await import('../../../src/session/session-manager.js');
    const sessionManager = new SessionManager('/tmp', ['/tmp']);

    const handle = setupWecomHandlers(mockClient, mockConfig, sessionManager);
    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.getRunningTaskCount).toBe('function');
    expect(handle.getRunningTaskCount()).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test -- tests/unit/wecom/event-handler.test.ts
```

Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 src/wecom/event-handler.ts**

```typescript
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { WSClient, WsFrame, TextMessage, ImageMessage, MixedMessage, VoiceMessage } from '@wecom/aibot-node-sdk';
import type { Config } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import type { SessionManager } from '../session/session-manager.js';
import { RequestQueue } from '../queue/request-queue.js';
import { registerPermissionSender, resolvePermissionById } from '../hook/permission-server.js';
import { CommandHandler, type CostRecord } from '../commands/handler.js';
import { runClaudeTask, type TaskRunState, type TaskDeps } from '../shared/claude-task.js';
import { startTaskCleanup } from '../shared/task-cleanup.js';
import { MessageDedup } from '../shared/message-dedup.js';
import { WECOM_THROTTLE_MS, IMAGE_DIR } from '../constants.js';
import { setActiveChatId } from '../shared/active-chats.js';
import { createWecomSender } from './message-sender.js';
import { createLogger } from '../logger.js';
import type { WecomEventHandlerHandle } from './client.js';

const log = createLogger('WecomHandler');

export { type WecomEventHandlerHandle };

async function downloadWecomImage(wsClient: WSClient, url: string, aesKey?: string): Promise<string> {
  await mkdir(IMAGE_DIR, { recursive: true });
  const { buffer, filename } = await wsClient.downloadFile(url, aesKey);
  const ext = filename?.split('.').pop() ?? 'jpg';
  const imagePath = join(IMAGE_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  await writeFile(imagePath, buffer);
  return imagePath;
}

export function setupWecomHandlers(
  wsClient: WSClient,
  config: Config,
  sessionManager: SessionManager,
): WecomEventHandlerHandle {
  const accessControl = new AccessControl(config.allowedUserIds);
  const requestQueue = new RequestQueue();
  const userCosts = new Map<string, CostRecord>();
  const runningTasks = new Map<string, TaskRunState>();
  const stopTaskCleanupFn = startTaskCleanup(runningTasks);
  const dedup = new MessageDedup();
  const sender = createWecomSender(wsClient);
  let accepting = true;

  const commandHandler = new CommandHandler({
    config,
    sessionManager,
    requestQueue,
    sender: { sendTextReply: (chatId, text) => sender.sendTextReply(chatId, text) },
    userCosts,
    getRunningTasksSize: () => runningTasks.size,
  });

  // 注册权限发送器
  registerPermissionSender('wecom', {
    sendPermissionCard: sender.sendPermissionCard,
    updatePermissionCard: sender.updatePermissionCard,
  });

  // 提取消息文本和 chatId
  function extractInfo(body: any): { userId: string; chatId: string; text: string; isGroup: boolean } {
    const userId = body.from?.userid ?? '';
    const chatId = body.chattype === 'group' ? (body.chatid ?? userId) : userId;
    const isGroup = body.chattype === 'group';
    let text = '';
    if (body.msgtype === 'text' && body.text?.content) {
      text = body.text.content.trim();
    } else if (body.msgtype === 'voice' && body.voice?.content) {
      text = body.voice.content.trim();
    }
    return { userId, chatId, text, isGroup };
  }

  // 群聊 @机器人检测
  function checkGroupMention(text: string): { mentioned: boolean; cleanText: string } {
    // 企业微信群聊中 @机器人 的文本格式为 "@机器人名 消息内容"
    // SDK 消息体 text.content 中已包含 @BotName 前缀
    // 使用简单规则：如果消息以 @ 开头，认为是 @机器人
    const mentionMatch = text.match(/^@\S+\s*/);
    if (mentionMatch) {
      return { mentioned: true, cleanText: text.slice(mentionMatch[0].length).trim() };
    }
    return { mentioned: false, cleanText: text };
  }

  async function handleClaudeRequest(
    userId: string,
    chatId: string,
    prompt: string,
    workDir: string,
    convId?: string,
    frame?: WsFrame,
  ): Promise<void> {
    const sessionId = convId ? sessionManager.getSessionIdForConv(userId, convId) : undefined;
    log.info(`Running Claude for user ${userId}, convId=${convId}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

    const taskKey = `${userId}:${chatId}`;

    // 初始化流式会话
    if (frame) {
      sender.initStream(frame, taskKey);
    }

    const deps: TaskDeps = { config, sessionManager, userCosts };
    const ctx = {
      userId,
      chatId,
      workDir,
      sessionId,
      convId,
      platform: 'wecom',
      taskKey,
    };

    await runClaudeTask(deps, ctx, prompt, {
      throttleMs: WECOM_THROTTLE_MS,
      streamUpdate: (content, toolNote) => {
        sender.sendStreamUpdate(content, toolNote).catch(() => {});
      },
      sendComplete: async (content, note) => {
        try {
          await sender.sendStreamComplete(content, note);
        } catch (err) {
          log.error('Failed to send complete:', err);
        }
      },
      sendError: async (error) => {
        try {
          await sender.sendStreamError(error);
        } catch (err) {
          log.error('Failed to send error:', err);
        }
      },
      onThinkingToText: (content) => {
        sender.resetStreamForTextSwitch(content).catch(() => {});
      },
      extraCleanup: () => {
        sender.cleanupStream();
        runningTasks.delete(taskKey);
      },
      onTaskReady: (state) => {
        runningTasks.set(taskKey, state);
      },
      sendImage: (imagePath) => sender.sendImage(chatId, imagePath),
    });
  }

  // 处理模板卡片事件（停止按钮、权限按钮）
  wsClient.on('event.template_card_event', async (frame) => {
    const body = frame.body;
    if (!body?.event) return;

    const eventKey = body.event.event_key ?? '';
    log.info(`Template card event: ${eventKey}`);

    if (eventKey.startsWith('stop_')) {
      const taskKey = eventKey.replace('stop_', '');
      const taskInfo = runningTasks.get(taskKey);
      if (taskInfo) {
        runningTasks.delete(taskKey);
        taskInfo.settle();
        taskInfo.handle.abort();
        // 更新卡片
        try {
          await wsClient.updateTemplateCard(frame, {
            card_type: 'button_interaction',
            main_title: { title: 'Claude Code - 已停止' },
            button_list: [{ text: '⏹️ 已停止', style: 2, key: 'stopped' }],
            task_id: body.event.task_id ?? `stopped_${Date.now()}`,
          });
        } catch (err) {
          log.warn('Failed to update stop card:', err);
        }
      }
    } else if (eventKey.startsWith('perm_allow_') || eventKey.startsWith('perm_deny_')) {
      const isAllow = eventKey.startsWith('perm_allow_');
      const requestId = eventKey.replace(/^perm_(allow|deny)_/, '');
      const decision = isAllow ? 'allow' as const : 'deny' as const;
      const resolved = resolvePermissionById(requestId, decision);
      // 更新卡片
      try {
        await wsClient.updateTemplateCard(frame, {
          card_type: 'text_notice',
          main_title: { title: `权限${isAllow ? '已允许 ✓' : '已拒绝 ✗'}` },
          task_id: body.event.task_id ?? requestId,
        });
      } catch (err) {
        log.warn('Failed to update permission card:', err);
      }
      if (!resolved) {
        log.warn(`Permission request ${requestId} not found or expired`);
      }
    }
  });

  // 通用消息处理
  async function handleMessage(frame: WsFrame, body: any): Promise<void> {
    if (!accepting) return;

    const { userId, chatId, text, isGroup } = extractInfo(body);
    if (!userId) return;

    // 去重
    if (dedup.isDuplicate(body.msgid)) {
      log.debug(`Duplicate message ${body.msgid}, skipping`);
      return;
    }

    // 访问控制
    if (!accessControl.isAllowed(userId)) {
      log.warn(`Access denied for user ${userId}`);
      await sender.sendTextReply(chatId, `抱歉，您没有访问权限。\n\n请联系管理员将您的用户 ID 添加到白名单。\n您的 ID: ${userId}`);
      return;
    }

    // 追踪活跃聊天
    setActiveChatId('wecom', chatId);

    // 群聊 @机器人 检测
    let processText = text;
    if (isGroup) {
      const { mentioned, cleanText } = checkGroupMention(text);
      if (!mentioned) return;
      processText = cleanText;
      if (!processText) return;
    }

    log.debug(`Processing message from user ${userId}: ${processText.slice(0, 100)}${processText.length > 100 ? '...' : ''}`);

    // /stop 命令（企业微信专有）
    if (processText.trim() === '/stop') {
      const userTasks = [...runningTasks.entries()].filter(([key]) => key.startsWith(`${userId}:`));
      if (userTasks.length > 0) {
        for (const [key, taskInfo] of userTasks) {
          runningTasks.delete(key);
          taskInfo.settle();
          taskInfo.handle.abort();
        }
        await sender.sendTextReply(chatId, `⏹️ 已停止 ${userTasks.length} 个运行中的任务`);
      } else {
        await sender.sendTextReply(chatId, 'ℹ️ 没有运行中的任务');
      }
      return;
    }

    // 统一命令分发
    if (processText.startsWith('/')) {
      const handled = await commandHandler.dispatch(
        processText, chatId, userId, 'wecom',
        (uId, cId, prompt, workDir, convId) => handleClaudeRequest(uId, cId, prompt, workDir, convId, frame),
      );
      if (handled) return;
    }

    // 路由到 Claude
    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, processText, async (prompt) => {
      await handleClaudeRequest(userId, chatId, prompt, workDirSnapshot, convIdSnapshot, frame);
    });

    if (enqueueResult === 'rejected') {
      await sender.sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sender.sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  }

  // 注册消息事件
  wsClient.on('message.text', async (frame: WsFrame<TextMessage>) => {
    await handleMessage(frame, frame.body);
  });

  wsClient.on('message.voice', async (frame: WsFrame<VoiceMessage>) => {
    await handleMessage(frame, frame.body);
  });

  wsClient.on('message.image', async (frame: WsFrame<ImageMessage>) => {
    if (!accepting || !frame.body) return;
    const body = frame.body;
    const { userId, chatId, isGroup } = extractInfo(body);
    if (!userId) return;
    if (dedup.isDuplicate(body.msgid)) return;
    if (!accessControl.isAllowed(userId)) return;

    // 群聊图片暂不处理（无法检测 @mention）
    if (isGroup) return;

    setActiveChatId('wecom', chatId);

    let imagePath: string;
    try {
      imagePath = await downloadWecomImage(wsClient, body.image.url, body.image.aeskey);
    } catch (err) {
      log.error('Failed to download image:', err);
      await sender.sendTextReply(chatId, '图片下载失败，请重试。');
      return;
    }

    const prompt = `用户发送了一张图片，已保存到 ${imagePath}。请用 Read 工具查看并分析图片内容。`;
    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, prompt, async (p) => {
      await handleClaudeRequest(userId, chatId, p, workDirSnapshot, convIdSnapshot, frame);
    });

    if (enqueueResult === 'rejected') {
      await sender.sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sender.sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  });

  wsClient.on('message.mixed', async (frame: WsFrame<MixedMessage>) => {
    if (!accepting || !frame.body) return;
    const body = frame.body;
    const { userId, chatId, isGroup } = extractInfo(body);
    if (!userId) return;
    if (dedup.isDuplicate(body.msgid)) return;
    if (!accessControl.isAllowed(userId)) return;
    if (isGroup) return; // 群聊混排消息暂不处理

    setActiveChatId('wecom', chatId);

    // 提取文本和图片
    const textParts: string[] = [];
    const imagePaths: string[] = [];

    for (const item of body.mixed?.msg_item ?? []) {
      if (item.msgtype === 'text' && item.text?.content) {
        textParts.push(item.text.content);
      } else if (item.msgtype === 'image' && item.image?.url) {
        try {
          const path = await downloadWecomImage(wsClient, item.image.url, item.image.aeskey);
          imagePaths.push(path);
        } catch (err) {
          log.error('Failed to download mixed image:', err);
        }
      }
    }

    const textContent = textParts.join(' ').trim();
    const imageInfo = imagePaths.length > 0
      ? `\n用户还发送了 ${imagePaths.length} 张图片，已保存到：${imagePaths.join(', ')}。请用 Read 工具查看。`
      : '';

    const prompt = textContent
      ? `${textContent}${imageInfo}`
      : imagePaths.length > 0
        ? `用户发送了 ${imagePaths.length} 张图片，已保存到：${imagePaths.join(', ')}。请用 Read 工具查看并分析图片内容。`
        : '';

    if (!prompt) return;

    const workDirSnapshot = sessionManager.getWorkDir(userId);
    const convIdSnapshot = sessionManager.getConvId(userId);

    const enqueueResult = requestQueue.enqueue(userId, convIdSnapshot, prompt, async (p) => {
      await handleClaudeRequest(userId, chatId, p, workDirSnapshot, convIdSnapshot, frame);
    });

    if (enqueueResult === 'rejected') {
      await sender.sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await sender.sendTextReply(chatId, '前面还有任务在处理中，您的请求已排队等待。');
    }
  });

  return {
    stop: () => {
      accepting = false;
      stopTaskCleanupFn();
    },
    getRunningTaskCount: () => runningTasks.size,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test -- tests/unit/wecom/event-handler.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wecom/event-handler.ts tests/unit/wecom/event-handler.test.ts
git commit -m "feat: 企业微信事件处理模块（消息、图片、命令、权限、停止）"
```

---

## Chunk 5: 主入口集成与完成

### Task 9: 集成到 src/index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 添加 import 语句**

在现有 import 块（第 1-17 行）中追加：

```typescript
import { initWecom, stopWecom } from './wecom/client.js';
import { setupWecomHandlers } from './wecom/event-handler.js';
import type { WecomEventHandlerHandle } from './wecom/client.js';
import { sendTextReply as wecomSendText } from './wecom/message-sender.js';
```

注意：`wecomSendText` 需要从 message-sender 导出一个独立函数版本。由于 `createWecomSender` 需要 `WSClient` 实例，我们需要调整。

实际方案：在 `sendLifecycleNotification` 中通过 `getWSClient()` 获取实例。添加一个顶层便捷函数：

在 `src/wecom/message-sender.ts` 末尾添加导出：

```typescript
import { getWSClient } from './client.js';

export async function sendTextReply(chatId: string, text: string): Promise<void> {
  try {
    const client = getWSClient();
    await client.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content: text },
    });
  } catch (err) {
    log.error('Failed to send text reply:', err);
  }
}
```

然后 index.ts 中导入：

```typescript
import { sendTextReply as wecomSendText } from './wecom/message-sender.js';
```

- [ ] **Step 2: 修改 sendLifecycleNotification**

第 28-43 行，修改 `sendLifecycleNotification` 函数：

```typescript
async function sendLifecycleNotification(activeBots: string[], message: string) {
  const tasks: Promise<void>[] = [];
  for (const bot of activeBots) {
    const platform = bot.toLowerCase() as 'feishu' | 'telegram' | 'wecom';
    const chatId = getActiveChatId(platform);
    if (!chatId) {
      log.info(`${bot} 启动通知跳过：尚无活跃聊天记录，向机器人发送一条消息后下次启动即可收到通知`);
      continue;
    }
    const sender = platform === 'feishu' ? feishuSendText : platform === 'wecom' ? wecomSendText : telegramSendText;
    tasks.push(sender(chatId, message).catch((err) => {
      log.debug(`Failed to send ${bot} lifecycle notification:`, err);
    }));
  }
  await Promise.allSettled(tasks);
}
```

- [ ] **Step 3: 添加 wecom 初始化代码块**

在第 73 行 `let telegramHandle` 后添加：

```typescript
  let wecomHandle: WecomEventHandlerHandle | null = null;
```

在第 96 行（telegram 初始化块之后，feishu 初始化块之前），添加：

```typescript
  if (config.enabledPlatforms.includes('wecom')) {
    log.debug('Initializing WeChat Work (WeCom) platform...');
    initTasks.push(
      initWecom(config, (wsClient) => {
        wecomHandle = setupWecomHandlers(wsClient, config, sessionManager);
        return wecomHandle;
      })
        .then(() => {
          log.info('WeCom bot initialized');
          return { platform: 'WeCom', success: true };
        })
        .catch((err) => {
          log.error('Failed to initialize WeCom bot:', err);
          log.warn('Continuing without WeCom support');
          return { platform: 'WeCom', success: false };
        })
    );
  }
```

- [ ] **Step 4: 添加 shutdown 处理**

在 shutdown 函数中，第 170 行 `feishuHandle?.stop();` 之后添加：

```typescript
    wecomHandle?.stop();
    if (config.enabledPlatforms.includes('wecom')) {
      stopWecom();
    }
```

修改 `getTotalTasks`（第 186 行），添加 wecom：

```typescript
    const getTotalTasks = () =>
      (feishuHandle?.getRunningTaskCount() ?? 0) +
      (telegramHandle?.getRunningTaskCount() ?? 0) +
      (wecomHandle?.getRunningTaskCount() ?? 0);
```

- [ ] **Step 5: 确认构建通过**

```bash
pnpm build
```

Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/wecom/message-sender.ts
git commit -m "feat: 主入口集成企业微信平台初始化和生命周期管理"
```

---

### Task 10: 运行全量测试

- [ ] **Step 1: 运行所有测试**

```bash
pnpm test
```

Expected: 所有测试 PASS。如有失败，定位并修复。

- [ ] **Step 2: 确认构建**

```bash
pnpm build
```

Expected: 无错误

- [ ] **Step 3: Commit 修复（如有）**

```bash
git add -A
git commit -m "fix: 修复企业微信集成后的测试问题"
```

---

### Task 11: 更新 CLAUDE.md 文档

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 在 CLAUDE.md 的「多平台支持架构」部分追加企业微信**

在「平台特定实现」部分（飞书和 Telegram 描述之后），添加：

```markdown
- 企业微信：`src/wecom/` - 使用 `@wecom/aibot-node-sdk`，WebSocket 长连接模式
  - 流式输出使用 SDK 原生 `replyStream()`，支持 Markdown
  - 6 分钟流式消息自动续接（5 分 30 秒触发）
  - 支持私聊和群聊，群聊需 @机器人触发
  - 图片消息通过 `downloadFile()` 下载并 AES 解密
  - 语音消息自动转文字（`voice.content`）
  - 权限确认使用模板卡片按钮（`sendMessage` 主动推送 + `updateTemplateCard` 更新）
  - 停止按钮通过 `replyStreamWithCard` 附带，同时支持 `/stop` 命令
```

- [ ] **Step 2: 在「环境变量列表」部分追加**

```markdown
- `WECOM_BOT_ID`：企业微信机器人 ID
- `WECOM_BOT_SECRET`：企业微信机器人 Secret
```

- [ ] **Step 3: 在「命令分类」部分追加**

在「平台特有」下添加：

```markdown
- `/stop`（企业微信，停止当前任务）
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 补充企业微信平台文档"
```

---

### Task 12: 更新 CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 在 `## [Unreleased]` 部分添加**

```markdown
### 新功能

- 新增企业微信（WeCom）平台支持
  - 使用 `@wecom/aibot-node-sdk` WebSocket 长连接接入
  - 支持私聊和群聊（@机器人触发）
  - 流式输出（`replyStream`），6 分钟自动续接
  - 权限确认模板卡片（允许/拒绝按钮）
  - 停止按钮 + `/stop` 命令
  - 图片消息接收（AES 解密）
  - 语音消息（自动转文字）
  - 配置：`WECOM_BOT_ID` + `WECOM_BOT_SECRET`
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录企业微信平台支持"
```
