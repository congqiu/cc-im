# cc-im

多平台（飞书 & Telegram & 企业微信）机器人 ↔ Claude Code CLI 桥接服务。

用户在飞书、Telegram 或企业微信中发消息，服务器接收后调用 Claude Code 执行，并将输出实时流式推送回聊天窗口。

## 功能

- **多平台支持**：飞书、Telegram 和企业微信，可同时运行或单独使用
- **流式输出**：飞书端使用 CardKit 打字机效果，Telegram 端通过 editMessage 实时更新，企业微信端使用 replyStream 原生流式回复
- **思考过程展示**：实时显示 Claude 的思考过程（折叠面板）
- **工具调用通知**：流式显示当前正在使用的工具及参数摘要
- **图片消息支持**：支持发送图片给 Claude 进行分析
- **截图自动发送**：Claude 使用截图工具后，任务完成时自动将截图上传到聊天窗口
- **话题会话**：飞书群聊话题（thread）独立会话
- **会话管理**：每用户独立 session，支持 `/new` 重置
- **并发控制**：同会话串行执行，不同会话可并发，最多排队 3 条消息
- **长消息分片**：超长内容自动拆分为多条消息
- **权限确认**：通过 Hook 机制实现工具调用的交互式审批
- **白名单**：通过环境变量或配置文件控制访问
- **停止按钮**：执行过程中可随时停止
- **工具使用统计**：完成时显示工具调用次数和类型
- **模型切换**：支持按用户和按话题粒度切换模型
- **轮次追踪**：累计对话轮次，上下文过长时自动提醒压缩
- **生命周期通知**：服务启动/关闭时通知活跃用户（含版本信息和运行时长）
- **守护进程模式**：支持 `-d` 后台运行和 `stop` 停止
- **终端监控**：通过 `/watch` 命令实时监控终端 Claude Code 的运行状态（工具调用、完成事件）
- **版本更新检查**：启动时自动检查 npm 最新版本，有更新时提示
- **日志等级配置**：支持 DEBUG/INFO/WARN/ERROR 四级日志

## 快速开始

> 要求：Node.js >= 20，需要预先安装 [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

### 同时运行多个平台

可以同时启用多个平台，只需配置对应平台的凭证即可：

```bash
export FEISHU_APP_ID=your_app_id
export FEISHU_APP_SECRET=your_app_secret
export TELEGRAM_BOT_TOKEN=your_bot_token
export WECOM_BOT_ID=your_bot_id
export WECOM_BOT_SECRET=your_bot_secret
npx cc-im@latest
```

服务会自动检测已配置的平台并启动对应的 bot。

### Telegram 平台

1. 通过 [@BotFather](https://t.me/BotFather) 创建 Bot，获取 Token
2. 配置并启动：

```bash
# 方式一：环境变量
export TELEGRAM_BOT_TOKEN=your_bot_token
npx cc-im@latest

# 方式二：从源码运行
pnpm install
cp .env.example .env
# 编辑 .env，填入 TELEGRAM_BOT_TOKEN
pnpm dev
```

3. 在 Telegram 中找到你的 Bot，发送 `/start` 开始使用

### 飞书平台

1. 在[飞书开放平台](https://open.feishu.cn)创建应用
2. 开启机器人能力
3. 添加权限：`im:message`、`im:message:send_as_bot`、`im:message.group_msg`、`im:message.p2p_msg:readonly`、`im:resource`、`cardkit:card:write`
4. 事件订阅中启用 **长连接模式**，订阅以下事件：
   - `im.message.receive_v1` — 接收消息
   - `im.message.recalled_v1` — 消息撤回（自动清理话题会话）
5. 回调订阅
   - `card.action.trigger` — 卡片交互（停止按钮）
6. 发布应用
7. 配置并启动：

```bash
export FEISHU_APP_ID=your_app_id
export FEISHU_APP_SECRET=your_app_secret
npx cc-im@latest
```

### 企业微信平台

1. 在[企业微信管理后台](https://work.weixin.qq.com)创建智能机器人应用
2. 获取机器人的 Bot ID 和 Secret
3. 配置并启动：

```bash
export WECOM_BOT_ID=your_bot_id
export WECOM_BOT_SECRET=your_bot_secret
npx cc-im@latest
```

4. 在企业微信中找到你的机器人，发送消息开始使用
5. 群聊中需要 @机器人 才会响应

### 从源码构建

```bash
git clone https://github.com/congqiu/cc-im.git
cd cc-im
pnpm install
cp .env.example .env
# 编辑 .env 填入对应平台凭证

pnpm dev      # 开发模式
pnpm build    # 编译
pnpm start    # 生产模式（前台）
```

### 守护进程模式

```bash
# 后台启动
cc-im -d

# 停止服务
cc-im stop
```

日志输出到 `~/.cc-im/logs/daemon.log`。

## 命令列表

| 命令 | 说明 |
|------|------|
| `/start` | 显示欢迎信息（Telegram） |
| `/help` | 显示帮助信息 |
| `/new` | 开始新会话 |
| `/cd <path>` | 切换工作目录（同时重置会话） |
| `/pwd` | 查看当前工作目录 |
| `/list` | 列出所有项目的工作区 |
| `/cost` | 查看 Claude API 用量和费用 |
| `/status` | 查看当前会话状态 |
| `/model [name]` | 查看或切换模型（按用户/话题粒度） |
| `/doctor` | 运行 Claude 诊断 |
| `/compact [topic]` | 压缩当前对话上下文 |
| `/history [page]` | 查看当前会话的对话历史 |
| `/resume [n]` | 浏览/恢复历史会话 |
| `/watch [level]` | 监控终端 Claude Code（stop/tool/full/off） |
| `/threads` | 列出所有话题会话（飞书） |
| `/stop` | 停止当前运行的任务（企业微信） |
| `/allow` 或 `/y` | 允许权限请求（按钮不可用时的备选） |
| `/deny` 或 `/n` | 拒绝权限请求（按钮不可用时的备选） |

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | 飞书平台必填 |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | 飞书平台必填 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | Telegram 平台必填 |
| `WECOM_BOT_ID` | 企业微信机器人 Bot ID | 企业微信平台必填 |
| `WECOM_BOT_SECRET` | 企业微信机器人 Secret | 企业微信平台必填 |
| `ALLOWED_USER_IDS` | 白名单用户 ID，逗号分隔，留空不限制 | 空（不限制） |
| `CLAUDE_CLI_PATH` | Claude CLI 可执行文件路径 | `claude` |
| `CLAUDE_WORK_DIR` | 默认工作目录 | 当前目录 |
| `ALLOWED_BASE_DIRS` | 允许 `/cd` 切换的基础目录，逗号分隔 | 同 `CLAUDE_WORK_DIR` |
| `CLAUDE_SKIP_PERMISSIONS` | 跳过权限检查（生产环境建议 `false`） | `false` |
| `CLAUDE_TIMEOUT_MS` | 执行超时（毫秒） | `600000`（10分钟） |
| `CLAUDE_MODEL` | 默认模型（如 `sonnet`、`opus`、`haiku`） | 空（由 Claude Code 决定） |
| `PROXY_URL` | 代理地址，传递给 Claude CLI（如 `http://127.0.0.1:7890`） | 空 |
| `HOOK_SERVER_PORT` | 权限确认 Hook 服务端口 | `18900` |
| `LOG_DIR` | 日志文件存储目录 | `~/.cc-im/logs` |
| `LOG_LEVEL` | 日志等级（`DEBUG`/`INFO`/`WARN`/`ERROR`） | `DEBUG` |

### 白名单用户 ID 格式

- **飞书**：open_id 格式，如 `ou_xxxx`
- **Telegram**：用户数字 ID，如 `123456789`（可通过 [@userinfobot](https://t.me/userinfobot) 获取）
- **企业微信**：企业微信 userid，如 `zhangsan`

## 配置文件

除环境变量外，也支持通过 `~/.cc-im/config.json` 文件配置：

```json
{
  "feishuAppId": "",
  "feishuAppSecret": "",
  "telegramBotToken": "your_bot_token",
  "wecomBotId": "",
  "wecomBotSecret": "",
  "allowedUserIds": ["123456789"],
  "claudeCliPath": "/usr/local/bin/claude",
  "claudeWorkDir": "/home/user/projects",
  "allowedBaseDirs": ["/home/user/projects", "/tmp"],
  "claudeSkipPermissions": false,
  "claudeTimeoutMs": 600000,
  "claudeModel": "sonnet",
  "proxyUrl": "http://127.0.0.1:7890",
  "hookPort": 18900,
  "logDir": "/var/log/cc-im",
  "logLevel": "INFO"
}
```

环境变量优先级高于配置文件。

## 应用数据目录

默认数据目录：`~/.cc-im`（常量 `APP_HOME`）

```
~/.cc-im/
├── config.json          # 配置文件
├── data/
│   ├── sessions.json    # 会话持久化数据
│   └── active-chats.json # 活跃聊天记录（生命周期通知）
└── logs/                # 日志文件（可通过 LOG_DIR 自定义）
    ├── 2026-02-14.log
    └── 2026-02-15.log
```

## 权限确认机制

### 配置 Claude CLI Hook

**必须**：在 Claude CLI 配置文件中添加 PreToolUse hook，使权限确认功能正常工作。

编辑 `~/.claude/settings.json`，在 `hooks` 中添加：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "<your-project-path>/dist/hook/hook-script.js"
          }
        ]
      }
    ]
  }
}
```

将 `<your-project-path>` 替换为实际的项目路径（使用绝对路径）。hook 脚本需要执行权限：`chmod +x dist/hook/hook-script.js`

配置修改后需要完全退出 Claude Code 会话（`exit`）并重新启动才能生效。

### 工作流程

当 `CLAUDE_SKIP_PERMISSIONS=false` 时，系统会通过 PreToolUse Hook 拦截敏感操作：

1. Claude Code 尝试调用工具（如执行 Bash 命令）
2. Hook 脚本将请求发送到权限确认服务（端口由 `HOOK_SERVER_PORT` 指定）
3. 服务向用户发送权限确认卡片
4. 用户点击卡片上的"允许"或"拒绝"按钮
5. 决定结果返回给 Claude Code，继续或中止操作

以下只读工具会自动放行，无需确认：
`Read`、`Glob`、`Grep`、`WebFetch`、`WebSearch`、`Task`、`TodoRead`

## 项目结构

```
src/
├── index.ts                  # 入口，多平台并行初始化
├── config.ts                 # 配置加载（环境变量 + ~/.cc-im/config.json）
├── constants.ts              # 系统常量（节流、长度限制、错误码等）
├── logger.ts                 # 带标签的日志系统（自动脱敏）
├── sanitize.ts               # 日志脱敏规则
├── cli.ts                    # CLI 入口（前台/守护进程/停止）
├── access/
│   └── access-control.ts     # 白名单访问控制
├── claude/
│   ├── cli-runner.ts         # Claude CLI 子进程管理
│   ├── stream-parser.ts      # stream-json 格式解析
│   └── types.ts              # Claude 消息类型定义
├── commands/
│   └── handler.ts            # 平台无关的命令处理器
├── feishu/
│   ├── client.ts             # 飞书 SDK 初始化
│   ├── event-handler.ts      # 飞书事件处理
│   ├── message-sender.ts     # 飞书消息发送封装
│   ├── card-builder.ts       # 飞书卡片构建（JSON 1.0 + 2.0）
│   └── cardkit-manager.ts    # CardKit 卡片生命周期管理
├── telegram/
│   ├── client.ts             # Telegraf 初始化
│   ├── event-handler.ts      # Telegram 事件处理
│   └── message-sender.ts     # Telegram 消息发送
├── wecom/
│   ├── client.ts             # 企业微信 WSClient 初始化
│   ├── event-handler.ts      # 企业微信事件处理
│   └── message-sender.ts     # 企业微信消息发送（流式回复、权限卡片）
├── hook/
│   ├── permission-server.ts  # 权限确认 HTTP 服务 + 监控通知端点
│   ├── hook-script.ts        # Claude Code PreToolUse Hook
│   ├── watch-script.ts       # Claude Code 监控 Hook（PostToolUse/Stop 等）
│   ├── watch.ts              # 监控状态管理与消息格式化
│   └── ensure-hook.ts        # Hook 自动配置
├── shared/
│   ├── active-chats.ts          # 活跃聊天记录（生命周期通知）
│   ├── claude-task.ts           # 共享 Claude 任务执行层（节流、统计、竞态保护）
│   ├── history.ts               # 会话历史读取与分页
│   ├── message-dedup.ts         # 消息去重（飞书重复事件过滤）
│   ├── retry.ts                 # 通用重试工具
│   ├── task-cleanup.ts          # 超时任务自动清理
│   ├── types.ts                 # 共享类型定义
│   ├── update-check.ts          # 启动时版本更新检查
│   └── utils.ts                 # 共享工具函数
├── session/
│   └── session-manager.ts    # 会话管理（持久化到 data/sessions.json）
└── queue/
    └── request-queue.ts      # 请求队列与并发控制
```

## License

MIT
