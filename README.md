# cc-feishu

飞书机器人 ↔ Claude Code CLI 桥接服务。

用户在飞书中发消息，服务器接收后调用 Claude Code 执行，并将输出实时流式推送回飞书消息卡片。

## 功能

- 流式输出：通过飞书卡片 PATCH 更新实现实时显示（500ms 节流）
- 会话管理：每用户独立 session，支持 `/clear` 重置
- 并发控制：每用户同时一个 CLI 进程，额外消息排队（最多 3 条）
- 长消息分片：超长内容自动拆分为多条续接卡片
- 白名单：通过环境变量配置访问控制

## 快速开始

```bash
# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入飞书应用凭证

# 启动服务
pnpm dev
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `FEISHU_APP_ID` | 飞书应用 App ID | 必填 |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret | 必填 |
| `ALLOWED_USER_IDS` | 白名单 open_id，逗号分隔，留空不限制 | 空 |
| `CLAUDE_CLI_PATH` | Claude CLI 路径 | `claude` |
| `CLAUDE_WORK_DIR` | 默认工作目录（用户可通过 `/cd` 切换） | 当前目录 |

## 飞书应用配置

1. 在[飞书开放平台](https://open.feishu.cn)创建应用
2. 开启机器人能力
3. 添加权限：`im:message`、`im:message:send_as_bot`
4. 事件订阅中启用长连接模式，订阅 `im.message.receive_v1` 事件
5. 发布应用

## 命令

| 命令 | 说明 |
|------|------|
| `/clear` | 清除当前会话，开始新的对话上下文 |
| `/cd <path>` | 切换工作目录（同时重置会话） |
| `/pwd` | 查看当前工作目录 |
| `/list` | 列出 Claude Code 操作过的所有工作区 |
