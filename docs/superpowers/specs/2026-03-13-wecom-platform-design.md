# 企业微信平台适配设计文档

## 概述

为 cc-im 新增企业微信（WeCom）平台支持，功能尽可能与飞书保持一致。使用官方 `@wecom/aibot-node-sdk` 通过 WebSocket 长连接接入，支持私聊和群聊，流式输出采用 SDK 原生 `replyStream` 能力，权限确认使用模板卡片按钮。

## 技术选型

- **SDK**：`@wecom/aibot-node-sdk` ^1.0.1（企业微信官方 Node.js SDK）
- **连接方式**：WebSocket 长连接（`wss://openws.work.weixin.qq.com`）
- **认证**：`botId` + `secret`，无需公网回调 URL
- **流式回复**：SDK 原生 `replyStream()`，支持 Markdown
- **权限交互**：模板卡片（`template_card`）+ 按钮

### SDK API 可用性确认（已验证 v1.0.1）

| API | 用途 | 状态 |
|-----|------|------|
| `replyStream()` | 流式文本回复 | ✅ 可用 |
| `replyStreamWithCard()` | 流式+模板卡片组合 | ✅ 可用 |
| `sendMessage()` | 主动推送消息（无需回调帧） | ✅ 可用 |
| `downloadFile()` | 文件下载+AES 解密 | ✅ 可用 |
| `replyTemplateCard()` | 回复模板卡片 | ✅ 可用 |
| `updateTemplateCard()` | 更新模板卡片（按钮点击后） | ✅ 可用 |

## 架构设计

### 新增文件

```
src/wecom/
├── client.ts           # WSClient 初始化与连接管理
├── event-handler.ts    # 消息事件处理 + Claude 集成
└── message-sender.ts   # 消息发送（流式回复、权限卡片、分片）
```

### 修改文件

- `src/config.ts`：
  - `Platform` 类型扩展为 `'feishu' | 'telegram' | 'wecom'`
  - `Config` 接口新增 `wecomBotId: string` 和 `wecomBotSecret: string` 字段
  - `FileConfig` 接口新增对应的可选字段
  - `detectPlatforms()` 加入企业微信检测
  - 无平台时的错误信息更新，包含企业微信的配置提示
- `src/constants.ts` — 新增企业微信相关常量
- `src/index.ts`：
  - `sendLifecycleNotification()` 添加 `wecom` 分支
  - 初始化代码块添加 wecom 并行初始化
  - `shutdown` 函数添加 wecom 停止逻辑
  - `getTotalTasks` 包含 wecom 的 running task 计数
- `src/commands/handler.ts`：
  - `dispatch()` 方法的 `platform` 参数类型同步更新
  - 新增 `/stop` 命令处理（企业微信专有）
- `package.json` — 新增 `@wecom/aibot-node-sdk` 依赖
- `CLAUDE.md` — 补充企业微信平台文档

### 新增测试

```
tests/unit/wecom/
├── client.test.ts
├── event-handler.test.ts
└── message-sender.test.ts
```

## 模块详细设计

### 1. client.ts — 连接管理

**职责**：初始化 `WSClient`，管理连接生命周期。

**核心函数**：

```typescript
export async function initWecom(
  config: Config,
  setupHandlers: (wsClient: WSClient) => WecomEventHandlerHandle
): Promise<{ wsClient: WSClient; handle: WecomEventHandlerHandle }>
```

**行为**：
- 使用 `botId` + `secret` 创建 `WSClient` 实例
- 桥接 SDK Logger 到项目的 `createLogger('Wecom')`
- 调用 `wsClient.connect()` 建立长连接
- 等待 `authenticated` 事件确认认证成功（超时 30 秒）
- 监听 `error`、`disconnected`、`reconnecting` 事件并记录日志
- 调用 `setupHandlers(wsClient)` 注册消息处理器
- 返回 `wsClient` 实例和 handler handle

**关闭**：
- `wsClient.disconnect()` 断开连接

### 2. event-handler.ts — 事件处理

**职责**：接收消息事件，分发命令或执行 Claude 任务。

**核心函数**：

```typescript
export function setupWecomHandlers(
  wsClient: WSClient,
  config: Config,
  sessionManager: SessionManager,
  ...
): WecomEventHandlerHandle
```

**返回类型**（与现有平台接口风格一致）：

```typescript
export interface WecomEventHandlerHandle {
  stop: () => void;
  getRunningTaskCount: () => number;
}
```

内部维护 `runningTasks: Map<string, TaskRunState>`，仅通过 `getRunningTaskCount()` 暴露计数。`commandHandler` 和 `permissionSender` 在函数内部创建，不对外暴露。

**消息处理流程**：

1. **消息接收**：监听 `message.text`、`message.image`、`message.mixed`、`message.voice` 事件
2. **去重**：使用 `MessageDedup`，以 `msgid` 去重
3. **访问控制**：`AccessControl` 检查 `from.userid` 是否在白名单
4. **群聊过滤**：`chattype === 'group'` 时检测文本是否包含 `@机器人名`，不包含则忽略；检测到后移除 `@BotName` 前缀
5. **命令分发**：以 `/` 开头走 `CommandHandler.handle()`
6. **Claude 任务**：入队 `RequestQueue`，调用 `runClaudeTask()`

**用户和聊天标识**：
- `userId`：`from.userid`（企业微信用户 ID）
- `chatId`：单聊用 `from.userid`，群聊用 `chatid`
- `platform`：`'wecom'`

**图片处理**：
- 通过 `wsClient.downloadFile(url, aesKey)` 下载并 AES 解密
- `aesKey` 来源：`body.image.aeskey`（图片消息）或 `item.image.aeskey`（混排消息中的图片）
- 下载后写入临时文件，路径传递给 Claude CLI
- 图片/文件 URL 5 分钟有效，收到后立即下载

**语音消息**：
- 企业微信 SDK 消息体中 `voice.content` 已包含自动转写的文本
- 直接提取 `body.voice.content` 作为用户输入，无需额外 ASR 服务

**模板卡片事件**：
- 监听 `event.template_card_event`
- 解析 `event_key`：
  - `stop_<taskKey>` — 停止运行中的 Claude 任务
  - `allow_<requestId>` — 允许权限请求
  - `deny_<requestId>` — 拒绝权限请求
- 立即调用 `updateTemplateCard()` 更新卡片状态（5 秒响应窗口内）

**`/stop` 命令**：
- 作为企业微信专有命令（类似飞书的 `/threads`），在 event-handler 内部处理
- 查找当前用户的 `runningTasks`，调用 `state.handle.abort()` 停止任务
- 不修改 `CommandHandlerDeps` 接口，避免跨平台影响

### 3. message-sender.ts — 消息发送

**职责**：封装所有消息发送逻辑，实现 `MessageSender` 和 `PermissionSender` 接口。

#### 3.1 流式回复

**核心设计**：使用 `replyStream()` 实现打字机效果，配合 6 分钟自动续接。

```typescript
// 首条消息：流式 + 停止按钮卡片
wsClient.replyStreamWithCard(frame, streamId, content, false, {
  templateCard: stopButtonCard
});

// 后续更新：纯流式
wsClient.replyStream(frame, streamId, content, false);

// 接近 5分30秒 时续接
wsClient.replyStream(frame, currentStreamId, currentContent, true); // 结束当前
newStreamId = generateReqId('stream');
wsClient.replyStream(frame, newStreamId, '', false); // 开启新 stream

// 完成
wsClient.replyStream(frame, currentStreamId, finalContent, true);
```

**节流**：200ms 间隔（`WECOM_THROTTLE_MS`）

**续接逻辑**：
- 记录每个 stream 的开始时间
- 每次节流更新时检查是否接近 5 分 30 秒（`WECOM_STREAM_TIMEOUT_MS = 330_000`）
- 触发续接时：结束当前 stream → 创建新 streamId → 继续更新
- 续接后的新 stream 是一条新消息，用户聊天中会看到内容被拆分为多条消息
- 续接后的 stream 不再附带停止按钮卡片，用户可用 `/stop` 命令

**思考→文本切换**：
- 思考阶段：内容带 `💭 **思考中...**` 前缀
- 切换到文本时：结束当前 stream（`finish=true`），开新 stream 发送纯文本内容（避免前缀突变导致全文重刷）

#### 3.2 完成消息

任务完成时：
- 最后一次 `replyStream(frame, streamId, content, true)` 结束流式
- 如果内容超过 `MAX_WECOM_MESSAGE_LENGTH`，分片通过 `sendMessage()` 发送额外部分
- note 信息（耗时、费用、工具统计等）附加在最终内容末尾

#### 3.3 权限确认卡片

权限请求来自 Hook 脚本（HTTP 请求），不是直接的消息回调，因此无法使用 `replyTemplateCard()`（需要回调帧的 `req_id`）。

**最终方案**：通过 `wsClient.sendMessage()` 主动推送模板卡片。

```typescript
wsClient.sendMessage(chatId, {
  msgtype: 'template_card',
  template_card: {
    card_type: 'button_interaction',
    main_title: { title: `权限确认: ${toolName}` },
    sub_title_text: toolInputSummary,
    button_list: [
      { text: '允许', style: 1, key: `allow_${requestId}` },
      { text: '拒绝', style: 2, key: `deny_${requestId}` },
    ],
    task_id: requestId,
  },
});
```

按钮点击后通过 `event.template_card_event` 接收，在 event-handler 中：
1. 立即调用 `updateTemplateCard()` 更新卡片显示决定结果（5 秒内）
2. 调用 `permissionServer.resolvePermissionById(requestId, decision)` 解析权限

同时保留 `/allow` `/deny` 命令作为 fallback。

#### 3.4 停止按钮

- 首条流式消息通过 `replyStreamWithCard()` 附带停止按钮卡片
- 按钮 `event_key`：`stop_<userId>:<chatId>`（作为任务查找键）
- 点击后：
  1. 立即调用 `updateTemplateCard()` 更新卡片为「已停止」
  2. 通过 `runningTasks` 查找任务并 abort
  3. 结束当前 stream
- 同时支持 `/stop` 命令作为 fallback

#### 3.5 启动/关闭通知

- 使用 `wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content } })` 主动推送
- 复用 `ActiveChats` 记录的活跃聊天

### 4. TaskAdapter 实现

```typescript
const adapter: TaskAdapter = {
  throttleMs: WECOM_THROTTLE_MS,           // 200ms
  streamUpdate(content, toolNote) { ... }, // replyStream 增量更新 + 续接检查
  sendComplete(content, note) { ... },     // replyStream finish + 分片
  sendError(error) { ... },               // replyStream finish 错误内容
  onThinkingToText(content) { ... },      // 结束旧 stream，开新 stream
  onTaskReady(state) { ... },             // 记录 TaskRunState
  onFirstContent() { ... },              // 首次内容到达时的处理
  extraCleanup() { ... },                // 清理 stream 状态
};
```

## 配置

### 新增环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WECOM_BOT_ID` | 企业微信机器人 ID | 无（必填） |
| `WECOM_BOT_SECRET` | 企业微信机器人 Secret | 无（必填） |

### Config 接口变更

```typescript
// 新增字段
export interface Config {
  // ... 现有字段
  wecomBotId: string;
  wecomBotSecret: string;
}

// FileConfig 对应可选字段
export interface FileConfig {
  // ... 现有字段
  wecomBotId?: string;
  wecomBotSecret?: string;
}
```

### config.json 示例

```json
{
  "wecomBotId": "your-bot-id",
  "wecomBotSecret": "your-bot-secret",
  "allowedUserIds": ["userid1", "userid2"]
}
```

### 平台检测

`detectPlatforms()` 新增企业微信检测：

```typescript
if (config.wecomBotId && config.wecomBotSecret) {
  platforms.push('wecom');
}
```

## 常量定义

```typescript
// 企业微信相关常量
export const WECOM_THROTTLE_MS = 200;              // 流式更新节流间隔
export const WECOM_STREAM_TIMEOUT_MS = 330_000;    // 流式续接阈值（5分30秒）
export const MAX_WECOM_MESSAGE_LENGTH = 4000;      // 消息长度限制
```

## 功能对照表

| 功能 | 飞书 | Telegram | 企业微信 |
|------|------|----------|----------|
| 连接方式 | WSClient 长连接 | 轮询 | WSClient 长连接 |
| 流式输出 | CardKit 打字机 | editMessage | replyStream |
| 流式节流 | 80ms | 200ms | 200ms |
| 流式超时 | 无硬限制 | 无 | 6min（自动续接为新消息） |
| 权限确认 | 卡片按钮 | InlineKeyboard | 模板卡片按钮（sendMessage 主动推送） |
| 权限确认更新 | im.v1.message.patch | editMessageText | updateTemplateCard |
| 停止按钮 | CardKit 按钮 | InlineKeyboard | 模板卡片按钮（replyStreamWithCard） |
| 停止命令 | 不支持 | 不支持 | /stop（企业微信专有） |
| 群聊触发 | @机器人 | @机器人 | @机器人 |
| 话题/Thread | 支持 | 不支持 | 不支持 |
| 图片接收 | SDK 下载 | Telegram API | SDK downloadFile() + AES 解密 |
| 图片发送 | 上传+消息 | sendPhoto | 不支持（SDK 限制） |
| 语音消息 | 不支持 | 不支持 | 支持（voice.content 自动转文字） |
| 消息撤回清理 | 支持 | 不支持 | 不支持（SDK 限制） |
| 主动推送 | API 发消息 | bot.telegram.sendMessage | sendMessage（markdown/template_card） |
| 消息去重 | MessageDedup | MessageDedup | MessageDedup |

## 不支持的功能（企业微信限制）

1. **话题/Thread** — 企业微信无话题概念，不实现 ThreadContext
2. **消息撤回回调** — SDK 不支持撤回事件
3. **图片发送** — 流式消息仅支持文本/Markdown，无法内嵌图片
4. **文件消息处理** — 暂不处理文件消息（仅处理文本、图片、语音、混排）

## 企业微信限制与应对

| 限制 | 应对 |
|------|------|
| 流式消息 6 分钟超时 | 5分30秒自动续接新 stream（新消息） |
| 消息频率 30条/分钟（每会话） | 200ms 节流 + 队列串行 |
| 模板卡片 5 秒响应窗口 | 按钮事件处理器立即响应，先更新卡片再异步执行后续操作 |
| 图片/文件 URL 5 分钟有效 | 收到后立即下载 |
| 图片/文件需 AES 解密 | 使用 SDK `downloadFile(url, aesKey)` |

## 错误处理

- **连接断开**：SDK 内置指数退避重连（1s → 30s），最多重连 10 次（可配置为无限）
- **回复发送失败**：记录错误日志，不重试（避免重复消息）
- **流式续接失败**：降级为 `sendMessage()` 发送完整 Markdown 内容；若 `sendMessage` 也失败则记录错误日志
- **权限卡片超时**：5 分钟未响应自动拒绝（复用现有 PermissionServer 逻辑）

## 测试策略

- Mock `WSClient` 和 `@wecom/aibot-node-sdk`
- 测试消息解析（文本、图片、混排、语音 voice.content）
- 测试群聊 @机器人 检测与文本清理
- 测试流式续接逻辑（时间模拟）
- 测试权限卡片发送（sendMessage 主动推送）与按钮事件处理
- 测试停止按钮（replyStreamWithCard）和 `/stop` 命令
- 测试消息分片
