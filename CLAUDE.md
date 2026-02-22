# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

cc-im 是一个多平台机器人桥接服务，连接飞书（Feishu）和 Telegram 到 Claude Code CLI。用户在聊天平台发送消息，服务器调用 Claude Code 执行，并将输出实时流式推送回聊天窗口。

## 开发命令

```bash
# 开发模式（自动重载）
pnpm dev

# 构建项目
pnpm build

# 生产模式运行（前台）
pnpm start

# 守护进程模式运行（后台）
cc-im -d

# 停止守护进程
cc-im stop

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
  - 流式输出使用 CardKit v1 API，打字机效果（详见下方「飞书 CardKit 流式架构」）
  - 支持群聊话题（thread）独立会话，每个话题有独立的 sessionId
  - 支持图片消息，自动下载并传递给 Claude
  - 消息撤回时自动清理关联的话题会话（`im.message.recalled_v1` 事件）
  - 权限卡片仍使用传统 `im.v1.message.patch` 更新
- Telegram：`src/telegram/` - 使用 `telegraf`，轮询模式
  - **仅支持私聊**：群组和话题（topic）消息会被拒绝

**飞书应用权限要求**：
- `im:message:send_as_bot` — 以应用身份发消息
- `im:message` — 获取与发送单聊、群组消息
- `im:message:patch_as_bot` — 更新应用发送的消息（权限卡片更新）
- `cardkit:card` — 创建与更新 CardKit 卡片（流式输出必需）

### 2. 会话管理（SessionManager）

位置：`src/session/session-manager.ts`

**关键概念**：
- `sessionId`：Claude Code 的会话 ID，用于 `--resume` 参数恢复对话上下文
- `convId`：对话 ID（conversation ID），用于请求队列隔离
- `workDir`：每个用户的工作目录

**设计要点**：
- 每个用户有独立的 sessionId 和 workDir
- 切换工作目录（`/cd`）或开始新会话（`/new`）时，旧的 convId 和 sessionId 会被转存到 `convSessionMap`（上限 200 条，超出自动淘汰最早的），供仍在运行的旧任务使用
- 会话数据持久化到 `data/sessions.json`，使用防抖保存（500ms）
- 飞书话题根消息被撤回时，通过 `removeThreadByRootMessageId()` 自动清理关联的话题会话
- 模型选择支持按用户和按话题粒度：`getModel(userId, threadId?)` 优先返回话题级模型，其次用户级模型，最后回退到全局配置

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

### 5. 共享任务执行层（ClaudeTask）

位置：`src/shared/claude-task.ts`

将两个平台重复的 Claude 任务执行逻辑（节流更新、完成统计、竞态保护、轮次追踪等）提取为共享模块。

**核心接口**：
- `TaskAdapter` — 平台适配器，各平台提供 `streamUpdate`、`sendComplete`、`sendError` 等具体实现
- `TaskContext` — 任务上下文（userId、chatId、workDir、sessionId、threadId 等）
- `TaskRunState` — 可变状态对象，调用方存入 `runningTasks` Map，任务运行期间 `latestContent` 持续更新

**`runClaudeTask()` 封装的通用逻辑**：
- 节流更新（各平台自定义间隔）
- 思考→文本切换检测
- 工具调用通知收集（保留最近 5 条，显示最近 3 条）
- 完成时构建 note（耗时/费用/工具统计/模型/上下文警告）
- `onComplete` / `onError` 竞态保护（`settled` 标记）
- sessionId 回写到 SessionManager
- 费用追踪与轮次累加

### 6. Claude CLI 集成

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
- `CC_IM_CHAT_ID`：聊天 ID，供 Hook 脚本识别用户
- `CC_IM_HOOK_PORT`：权限服务器端口
- `CC_IM_THREAD_ROOT_MSG_ID`：话题根消息 ID（飞书话题会话）
- `CC_IM_THREAD_ID`：话题 ID
- `CC_IM_PLATFORM`：当前平台标识（`feishu` / `telegram`）

**流式输出处理**：
- 使用 `readline` 逐行解析 stdout
- `stream-parser.ts` 解析 stream-json 格式
- 提取文本增量（`extractTextDelta`）和思考过程（`extractThinkingDelta`）
- 工具调用通知：通过 `onToolUse` 回调实时显示当前工具名称和参数摘要
- 工具使用统计：完成时汇总各工具调用次数
- 累积文本并通过回调实时推送

**错误处理**：
- stderr 保留首尾部分（前 4KB + 后 6KB），避免超长错误信息导致内存溢出
- 超时控制：默认 10 分钟（`CLAUDE_TIMEOUT_MS`）

### 7. 命令系统

位置：`src/commands/handler.ts`

**设计原则**：
- 平台无关：通过 `MessageSender` 接口抽象平台差异
- 依赖注入：通过 `CommandHandlerDeps` 注入所有依赖
- 统一处理：所有命令在同一个类中处理

**命令分类**：
- 会话管理：`/new`、`/compact`
- 工作目录：`/cd`、`/pwd`、`/list`
- 状态查询：`/status`、`/cost`、`/doctor`、`/todos`、`/history`
- 权限管理：`/allow`、`/deny`、`/allowall`、`/pending`
- 模型切换：`/model`（按用户/话题粒度，存储在 SessionManager 中，不修改全局配置）
- 平台特有：`/threads`（飞书，列出话题会话）、`/start`（Telegram）

### 8. 飞书 CardKit 流式架构

飞书端的流式输出使用 CardKit v1 API 实现打字机效果，相关模块：

- `src/feishu/cardkit-manager.ts` — CardKit 实体生命周期管理
- `src/feishu/card-builder.ts` — 卡片 JSON 构建（V1 用于权限卡片，V2 用于主流程）
- `src/feishu/message-sender.ts` — 消息发送封装

**卡片生命周期**：
1. `card.create` 创建卡片 → 获得 `cardId`
2. 并行：`card.settings(streaming_mode: true)` + `im.v1.message.create(card_id)` 发送到聊天
3. `card.update` 补充停止按钮（此时 cardId 已知）
4. 流式阶段：`cardElement.content` 增量更新 `main_content` 元素，80ms 节流（`CARDKIT_THROTTLE_MS`）
5. 完成/错误：`card.settings(streaming_mode: false)` 关闭流式模式 → `card.update` 全量更新（改 header 颜色、移除按钮、更新 note）
6. `destroySession` 清理内存中的 session

**卡片 JSON 格式**：
- 主流程使用 JSON 2.0（`schema: "2.0"`，`body.elements`），元素需要 `element_id`
- V2 不支持 `tag: "note"` 和 `tag: "action"`，替代方案：
  - note → `tag: "markdown"` + `text_size: "notation"`
  - action 包装器 → 直接放 `tag: "button"` 到 elements
- 活跃状态（processing/thinking/streaming）的卡片 config 需包含 `streaming_mode: true`，保持流式模式不被 `card.update` 重置
- 完成/错误时必须显式调用 `card.settings` 将 `streaming_mode` 设为 `false` 关闭流式模式（`card.update` 省略该字段不会关闭）
- 权限卡片仍使用 JSON 1.0（`config` + `header` + `elements`）

**思考→文本切换**：
- 思考阶段内容带 `💭 **思考中...**` 前缀，切换到文本输出时前缀消失
- CardKit 增量渲染依赖内容前缀匹配，前缀突变会导致整段内容一次性重渲染（闪烁）
- 解决方案：切换时调用 `updateCardFull` 重置卡片基线，后续流式更新恢复增量渲染

**停止按钮**：
- 按钮 value 携带 `card_id`，任务追踪键为 `userId:cardId`
- 点击停止后通过 `updateCardFull` API 更新卡片为完成状态（回调返回值对 CardKit 卡片无效）
- 更新完成后调用 `destroySession` 清理

**CardKit API 重试策略**：
- `card.create` 不使用重试（创建操作不幂等，重试会产生孤儿卡片）
- 其他 API（`enableStreaming`、`updateCardFull` 等）使用 `withRetry` 自动重试

**CardKit API 错误码处理**：
- Lark SDK 不抛异常，错误码在 `res.code` 中返回，需显式检查
- `200810`（用户交互中）→ 静默忽略
- `200850` / `300309`（流式超时/关闭）→ 自动重新启用 streaming_mode 后重试一次
- `300317`（sequence 冲突）→ 静默忽略，下次自动修正
- `200400`（限频）→ 静默忽略，等下次节流重试

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
- 流式输出节流：飞书 CardKit 80ms（`CARDKIT_THROTTLE_MS`）、Telegram 200ms（`THROTTLE_MS`）
- 常量统一定义在 `src/constants.ts`
- 消息长度限制：飞书流式阶段 25000 字符（CardKit）、完成卡片 3800 字符、Telegram 4000 字符，超长自动分片

## 配置管理

位置：`src/config.ts`

**配置来源**（优先级从高到低）：
1. 环境变量
2. `~/.cc-im/config.json` 配置文件
3. 默认值

**环境变量列表**：
- `LOG_DIR`：日志目录路径，默认 `~/.cc-im/logs`
- `FEISHU_APP_ID`、`FEISHU_APP_SECRET`：飞书应用凭证
- `TELEGRAM_BOT_TOKEN`：Telegram 机器人 Token
- `ALLOWED_USER_IDS`：允许的用户 ID 列表（逗号分隔）
- `CLAUDE_CLI_PATH`：Claude CLI 可执行文件路径，默认 `claude`
- `CLAUDE_WORK_DIR`：默认工作目录，默认当前目录
- `ALLOWED_BASE_DIRS`：允许的基础目录列表（逗号分隔）
- `CLAUDE_SKIP_PERMISSIONS`：是否跳过权限确认，默认 `false`
- `CLAUDE_TIMEOUT_MS`：Claude CLI 超时时间（毫秒），默认 600000（10分钟）
- `CLAUDE_MODEL`：Claude 模型名（如 `sonnet`、`opus`，可被用户 `/model` 命令覆盖）
- `HOOK_SERVER_PORT`：权限服务器端口，默认 18900
- `LOG_LEVEL`：日志等级（`DEBUG`/`INFO`/`WARN`/`ERROR`），默认 `DEBUG`

**应用数据目录**：
- 根目录：`~/.cc-im`（常量 `APP_HOME`，定义在 `src/constants.ts`）
- 配置文件：`~/.cc-im/config.json`
- 会话数据：`~/.cc-im/data/sessions.json`
- 活跃聊天：`~/.cc-im/data/active-chats.json`
- 日志文件：`~/.cc-im/logs/` 或 `$LOG_DIR`

## 日志系统

位置：`src/logger.ts` + `src/sanitize.ts`

带标签的日志记录器，输出到 stdout/stderr 和日志目录下的日期文件（自动轮转，最多保留 10 个）。

**日志目录配置**：
- 通过 `LOG_DIR` 环境变量或配置文件 `logDir` 字段指定
- 默认 `~/.cc-im/logs`
- 在 `main()` 中调用 `initLogger(config.logDir)` 初始化

所有日志经过 `sanitize()` 自动脱敏：飞书 open_id 截断、UUID/session ID 只保留末 4 位、绝对路径只保留最后两段。业务代码无需手动处理。

各模块标签：`Main`、`Config`、`Session`、`Queue`、`PermissionServer`、`ClaudeTask`、`EventHandler`（飞书）、`TgHandler`（Telegram）。

## 常见开发任务

- **添加新命令**：使用 `/add-command` skill，会引导完成 `commands/handler.ts` + 两个平台事件处理器 + 帮助文本的修改
- **添加新平台**：在 `src/<platform>/` 下实现 `client.ts`、`event-handler.ts`、`message-sender.ts`，然后在 `src/index.ts` 和 `src/config.ts` 中注册
- **发布新版本**：使用 `/release` skill，会自动更新 CHANGELOG.md、版本号、创建 tag 并推送

## CHANGELOG 维护

项目使用 `CHANGELOG.md` 记录版本变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

- 日常开发中的变更记录在 `## [Unreleased]` 部分
- 分类：`### 新功能`（feat）、`### 修复`（fix）、`### 重构`（refactor）、`### 性能`（perf）、`### 其他`
- `/release` 时自动将 Unreleased 部分转为版本号和日期
