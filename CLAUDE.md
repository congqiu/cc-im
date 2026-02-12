# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

cc-bot 是一个多平台机器人桥接服务，连接飞书（Feishu）和 Telegram 到 Claude Code CLI。用户在聊天平台发送消息，服务器调用 Claude Code 执行，并将输出实时流式推送回聊天窗口。

## 开发命令

```bash
# 开发模式（自动重载）
pnpm dev

# 构建项目
pnpm build

# 生产模式运行
pnpm start

# 运行测试
pnpm test

# 监视模式测试
pnpm test:watch
```

## 核心架构

### 1. 多平台支持架构

项目支持飞书和 Telegram 两个平台，可以同时运行或单独使用。

- **平台检测**：`src/config.ts` 中的 `detectPlatforms()` 自动检测已配置的平台
- **并行初始化**：`src/index.ts` 中使用 `Promise.all()` 并行初始化多个平台
- **统一接口**：通过 `MessageSender` 接口抽象平台差异，命令处理器（`src/commands/handler.ts`）平台无关

平台特定实现：
- 飞书：`src/feishu/` - 使用 `@larksuiteoapi/node-sdk`，长连接模式
- Telegram：`src/telegram/` - 使用 `telegraf`，轮询模式

### 2. 会话管理（SessionManager）

位置：`src/session/session-manager.ts`

**关键概念**：
- `sessionId`：Claude Code 的会话 ID，用于 `--resume` 参数恢复对话上下文
- `convId`：对话 ID（conversation ID），用于请求队列隔离
- `workDir`：每个用户的工作目录

**设计要点**：
- 每个用户有独立的 sessionId 和 workDir
- 切换工作目录（`/cd`）或开始新会话（`/new`）时，旧的 convId 和 sessionId 会被转存到 `convSessionMap`，供仍在运行的旧任务使用
- 会话数据持久化到 `data/sessions.json`，使用防抖保存（500ms）

### 3. 请求队列（RequestQueue）

位置：`src/queue/request-queue.ts`

**队列策略**：
- 队列键：`userId:convId`（不是单纯的 userId）
- 同一队列的任务串行执行
- 不同队列的任务可以并发执行
- 最多排队 3 条消息，超过则拒绝

**为什么使用 convId**：
- 允许同一用户在不同对话中并发（例如切换工作目录后，新旧任务可以并发）
- 避免用户切换上下文后被旧任务阻塞

### 4. 权限确认机制

位置：`src/hook/permission-server.ts` 和 `src/hook/hook-script.ts`

**工作流程**：
1. Claude Code 执行敏感工具前调用 PreToolUse Hook（`hook-script.ts`）
2. Hook 脚本向本地 HTTP 服务器（默认端口 18900）发送权限请求
3. 服务器通过 `PermissionSender` 接口向用户发送权限确认卡片/消息
4. 用户回复 `/allow` 或 `/deny`
5. 决定返回给 Hook 脚本，Hook 脚本返回给 Claude Code

**关键设计**：
- 权限请求存储在 `pendingRequests` Map 中
- 超时时间：5 分钟（`PERMISSION_REQUEST_TIMEOUT_MS`）
- 只读工具自动放行：`Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch`、`Task`、`TodoRead`
- 使用 `resolveLatestPermission()` 解决最早的待确认请求（FIFO）

### 5. Claude CLI 集成

位置：`src/claude/cli-runner.ts`

**关键参数**：
```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  [--dangerously-skip-permissions] \
  [--model <model>] \
  [--resume <sessionId>] \
  -- <prompt>
```

**环境变量传递**：
- `CC_BOT_CHAT_ID`：聊天 ID，供 Hook 脚本识别用户
- `CC_BOT_HOOK_PORT`：权限服务器端口

**流式输出处理**：
- 使用 `readline` 逐行解析 stdout
- `stream-parser.ts` 解析 stream-json 格式
- 提取文本增量（`extractTextDelta`）和思考过程（`extractThinkingDelta`）
- 累积文本并通过回调实时推送

**错误处理**：
- stderr 保留首尾部分（前 4KB + 后 6KB），避免超长错误信息导致内存溢出
- 超时控制：默认 5 分钟（`CLAUDE_TIMEOUT_MS`）

### 6. 命令系统

位置：`src/commands/handler.ts`

**设计原则**：
- 平台无关：通过 `MessageSender` 接口抽象平台差异
- 依赖注入：通过 `CommandHandlerDeps` 注入所有依赖
- 统一处理：所有命令在同一个类中处理

**命令分类**：
- 会话管理：`/new`、`/compact`
- 工作目录：`/cd`、`/pwd`、`/list`
- 状态查询：`/status`、`/cost`、`/doctor`、`/todos`
- 权限管理：`/allow`、`/deny`、`/allowall`、`/pending`
- 模型切换：`/model`

## 测试

项目使用 vitest 进行单元测试，覆盖全部核心模块。

**运行测试**：
```bash
pnpm test          # 单次运行
pnpm test:watch    # 监视模式
```

测试位于 `tests/unit/`，目录结构与 `src/` 对应。运行单个测试文件：

```bash
pnpm test -- tests/unit/queue/request-queue.test.ts
```

## 关键约定

- 项目使用 **pnpm** 作为包管理器
- ESM 模块（`"type": "module"`），导入路径需要 `.js` 后缀
- TypeScript strict 模式，target ES2023
- commit 信息使用中文，格式 `<type>: <subject>`
- 流式输出更新使用 200ms 节流（`THROTTLE_MS`），避免 API 限流
- 常量统一定义在 `src/constants.ts`
- 消息长度限制：飞书卡片 3800 字符、Telegram 4000 字符，超长自动分片

## 配置管理

位置：`src/config.ts`

**配置来源**（优先级从高到低）：
1. 环境变量
2. `~/.cc-bot/config.json` 配置文件
3. 默认值

## 日志系统

位置：`src/logger.ts` + `src/sanitize.ts`

带标签的日志记录器，输出到 stdout/stderr 和 `logs/` 目录下的日期文件（自动轮转，最多保留 10 个）。

所有日志经过 `sanitize()` 自动脱敏：飞书 open_id 截断、UUID/session ID 只保留末 4 位、绝对路径只保留最后两段。业务代码无需手动处理。

各模块标签：`Main`、`Config`、`Session`、`Queue`、`PermissionServer`、`EventHandler`（飞书）、`TgHandler`（Telegram）。

## 常见开发任务

- **添加新命令**：使用 `/add-command` skill，会引导完成 `commands/handler.ts` + 两个平台事件处理器 + 帮助文本的修改
- **添加新平台**：在 `src/<platform>/` 下实现 `client.ts`、`event-handler.ts`、`message-sender.ts`，然后在 `src/index.ts` 和 `src/config.ts` 中注册
