# 代码库优化设计方案

日期：2026-03-14
方案：混合方案 C — 共享层提取 + 飞书事件处理器拆分 + 测试补全

## 1. 概述

本次优化目标：
1. **提取共享层** — 统一重试工具、增强消息发送接口、命令平台路由
2. **拆分飞书事件处理器** — 将 570 行的 `feishu/event-handler.ts` 按职责拆分
3. **测试补全与质量加固** — 补充关键路径测试、统一错误恢复、清理代码风格

企业微信（499 行）和 Telegram（322 行）不做文件拆分，仅通过共享层提取减少行数。

## 2. 共享层提取

### 2.1 增强重试工具 `src/shared/retry.ts`

**修改现有文件**。`src/shared/retry.ts` 已存在，当前接口：

```typescript
// 现有接口
interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}
```

在现有基础上增量扩展，新增 `shouldRetry` 回调：

```typescript
interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;       // 保留现有命名
  maxDelayMs?: number;        // 保留现有命名
  shouldRetry?: (error: unknown) => boolean;  // 新增：自定义可重试判断
}
```

与现有 `NonRetryableError` 的关系：`shouldRetry` 回调在 `NonRetryableError` 检查之后执行，两者互补。`NonRetryableError` 用于代码内部标记不可重试，`shouldRetry` 用于调用方按错误类型定制。

**替换/统一位置**：
- `feishu/cardkit-manager.ts` — 已使用共享版本，无需替换
- Telegram `message-sender.ts` — 仅将"捕获 429 错误后的重试等待"部分用 `withRetry` 重写；保留 `chatCooldownUntil` 前置冷却机制不动（这是前置限流，非失败重试）
- 企业微信流式更新失败的静默跳过 → 可选加入重试

### 2.2 增强消息发送接口 `src/shared/types.ts`

当前 `MessageSender` 接口定义在 `src/commands/handler.ts`，仅有 `sendTextReply` 一个方法。

**变更**：
1. 将 `MessageSender` 接口定义迁移到 `src/shared/types.ts`
2. 新增方法标记为**可选**（`?:`），允许增量实现，避免一次性修改所有平台

```typescript
interface MessageSender {
  // 已有
  sendTextReply(chatId: string, text: string, context?: MessageContext): Promise<void>;
  // 新增（可选，各平台按需实现）
  sendError?(chatId: string, error: string, context?: MessageContext): Promise<void>;
  sendPermissionCard?(chatId: string, request: PermissionRequest, context?: MessageContext): Promise<void>;
  updatePermissionCard?(chatId: string, requestId: string, result: PermissionResult, context?: MessageContext): Promise<void>;
}
```

注意：权限相关方法当前由 `registerPermissionSender` 独立注册，不走 `MessageSender`。将它们合并到接口中是为了统一平台抽象层，但标记为可选以保持向后兼容。

三个平台各自实现。不强求流式相关方法统一（各平台差异太大）。

### 2.3 命令平台路由（低优先级，可选）

当前平台特定命令只有 2-3 个条件分支（Telegram `/start`、飞书 `/threads`），引入注册机制的收益有限。**仅在平台命令增长到 5 个以上时再考虑实施**。

如果实施，方案如下：

```typescript
// CommandHandler 构造时接收平台命令映射
interface PlatformCommands {
  [command: string]: (ctx: CommandContext) => Promise<void>;
}

// 各平台在初始化时传入
new CommandHandler({ ..., platformCommands: { '/threads': handleThreads } });
```

注意：企业微信 `/stop` 当前在 event-handler 中直接处理（需访问 `runningTasks`），不适合迁移到 CommandHandler。

## 3. 飞书事件处理器拆分

### 3.1 当前结构（570 行单文件）

`feishu/event-handler.ts` 当前职责：
- 事件注册与消息分发
- 文本/图片/话题消息处理
- 权限卡片按钮回调
- Claude 任务执行与 CardKit 流式更新
- 停止按钮回调处理

### 3.2 拆分后结构

#### `feishu/event-handler.ts`（入口分发器，~100 行）
- `setupFeishuHandlers()` — 注册所有飞书事件监听
- 消息类型分发（文本 / 图片 / 话题 / 撤回）
- 卡片回调分发（权限 / 停止）
- 不包含业务逻辑，只做路由

#### `feishu/task-executor.ts`（任务执行，~200 行）
- `executeClaudeTask(params)` — 核心任务执行
- CardKit 卡片创建、流式更新、思考→文本切换
- 完成/错误时的卡片更新
- 停止按钮回调处理
- `runningTasks` Map 管理

#### `feishu/permission-handler.ts`（权限处理，~80 行）
- `handlePermissionAction(action)` — 权限卡片按钮回调
- `sendPermissionRequest(chatId, request)` — 构建并发送权限确认卡片
- 权限卡片状态更新

### 3.3 依赖关系

```
event-handler.ts (入口分发)
  ├→ task-executor.ts (任务执行)
  │   ├→ message-sender.ts (消息发送)
  │   └→ cardkit-manager.ts (CardKit API)
  └→ permission-handler.ts (权限处理)
      └→ message-sender.ts
```

各模块之间通过函数参数传递依赖，不使用全局状态。

### 3.4 共享状态与导出接口

`runningTasks` Map 由 `task-executor.ts` 持有并导出查询/操作接口：

```typescript
// task-executor.ts 导出
function createTaskExecutor(deps: TaskExecutorDeps): {
  executeTask(params: TaskParams): Promise<void>;
  handleStopAction(userId: string, cardId: string): void;
  getRunningTask(key: string): TaskRunState | undefined;
};
```

`event-handler.ts` 在卡片回调分发时调用 `handleStopAction()`，无需直接访问 `runningTasks`。

## 4. 测试补全

### 4.1 新增 `tests/unit/hook/hook-script.test.ts`

覆盖 `src/hook/hook-script.ts`（136 行），测试场景：

| 场景 | 预期 |
|------|------|
| 只读工具（Read/Glob/Grep）| 自动放行，不发 HTTP 请求 |
| 敏感工具（Bash/Write/Edit）| 发 HTTP 请求到权限服务器 |
| 权限服务器返回 allow | 脚本返回 allow |
| 权限服务器返回 deny | 脚本返回 deny |
| 权限服务器不可达 | 返回 deny（安全降级）|
| 请求超时 | 返回 deny |

Mock：`http.request`、stdin 输入。不启动真实服务器。

**注意**：`hook-script.ts` 的 `main()` 在模块顶层直接调用，import 时立即执行。测试需通过 `vi.mock` 拦截 `process.stdin`/`process.exit`，或将 `main()` 调用改为条件执行（检查 `import.meta.url`）。

### 4.2 新增 `tests/unit/feishu/client.test.ts`

覆盖 `src/feishu/client.ts`（53 行）。重点测试错误场景而非正常初始化（正常路径本质上是测 SDK 构造函数，价值有限）：

| 场景 | 预期 |
|------|------|
| bot info 获取失败 | 优雅降级，输出错误日志 |
| 缺少必要配置 | 抛出明确错误 |

### 4.3 拆分后新文件的测试

- `tests/unit/feishu/task-executor.test.ts` — 任务执行流程
- `tests/unit/feishu/permission-handler.test.ts` — 权限处理逻辑
- `tests/unit/shared/retry.test.ts` — 已存在，需更新以覆盖新增的 `shouldRetry` 功能

### 4.4 现有测试更新

- `tests/unit/feishu/event-handler.test.ts` — 简化为只测分发逻辑
- 原有的任务执行和权限处理测试迁移到对应的新测试文件

## 5. 代码风格修复

import 长行问题（`feishu/event-handler.ts` 第 8 行 190+ 字符）随飞书拆分自然解决，无需独立步骤。

## 6. 变更范围总结

| 类别 | 新建文件 | 修改文件 |
|------|---------|---------|
| 共享层 | — | `src/shared/retry.ts`（增强）、`src/shared/types.ts`（迁移接口）、`src/commands/handler.ts`（import 路径） |
| 飞书拆分 | `src/feishu/task-executor.ts`、`src/feishu/permission-handler.ts` | `src/feishu/event-handler.ts` |
| 接口迁移 | — | 三个平台的 event-handler（import `MessageSender` 路径变更） |
| 测试新增 | `tests/unit/hook/hook-script.test.ts`、`tests/unit/feishu/client.test.ts`、`tests/unit/feishu/task-executor.test.ts`、`tests/unit/feishu/permission-handler.test.ts` | — |
| 测试更新 | — | `tests/unit/shared/retry.test.ts`、`tests/unit/feishu/event-handler.test.ts` |
| Telegram | — | `src/telegram/message-sender.ts`（429 重试部分用 withRetry） |

## 8. 推荐实施顺序

1. **共享层增强** — `retry.ts` 接口扩展 + `MessageSender` 接口迁移到 `types.ts`
2. **飞书事件处理器拆分** — 依赖共享层的 `withRetry`
3. **Telegram 重试统一** — 依赖共享层的 `withRetry`
4. **测试补全** — 依赖拆分后的文件结构
5. **全量测试验证** — `pnpm test` 确保无回归

## 7. 不包含在本次优化中

- 企业微信和 Telegram 事件处理器拆分（行数可接受）
- 分布式追踪 / OpenTelemetry（低优先级）
- 数据库迁移（当前 JSON 文件适合小规模使用）
- 速率限制和审计日志（安全加固，另行规划）
