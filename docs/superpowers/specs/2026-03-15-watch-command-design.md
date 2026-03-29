# 终端 Claude Code 监控（/watch 命令）设计方案

## 背景

用户在电脑终端运行 Claude Code 时，希望能通过聊天平台（飞书/Telegram/企业微信）实时获取执行状态和输出，无需一直盯着终端。

## 命令设计

```
/watch          → 显示当前监控状态
/watch tool     → 监控工具调用 + 完成事件
/watch stop     → 仅监控完成事件
/watch full     → 全量监控（工具+子代理+完成）
/watch off      → 关闭监控
```

监控绑定到**当前工作区**（chatId 对应的 workDir）。同一工作区可被多个聊天上下文同时监控（如飞书话题 + Telegram 私聊）。在话题/群组中发 `/watch`，监控信息会发到对应的话题/群组。

---

## 监控级别

| 级别 | PostToolUse | Stop | SubagentStart/Stop |
|------|:-:|:-:|:-:|
| stop | | ✓ | |
| tool | ✓ | ✓ | |
| full | ✓ | ✓ | ✓ |

---

## 数据流

```
终端 claude (任意工作区)
  ↓ hook 触发（PostToolUse / Stop / SubagentStart / SubagentStop）
watch-script.ts（新的 hook 脚本）
  ↓ POST http://127.0.0.1:{port}/watch-notify
  ↓ body: { cwd, eventName, sessionId?, toolName?, toolInput?, toolResponse?, lastAssistantMessage?, agentType? }
cc-im 权限服务器（已有 HTTP 端口 18900）
  ↓ 按 cwd 前缀匹配 watchMap
  ↓ 检查监控级别是否包含该事件类型
各平台 sendTextReply → 用户聊天（chatId + threadCtx）
```

---

## 核心数据结构

```typescript
interface WatchEntry {
  chatId: string;
  platform: Platform;
  threadCtx?: ThreadContext;
  level: 'stop' | 'tool' | 'full';
}

// workDir → WatchEntry[]（同一工作区可有多个监控者）
type WatchMap = Map<string, WatchEntry[]>;
```

`watchMap` 为纯内存结构，不持久化。服务重启后监控状态清空，用户需重新 `/watch`。

---

## 实现模块

### 1. watch-script.ts（新文件）

位置：`src/hook/watch-script.ts`

Hook 脚本，处理 PostToolUse / Stop / SubagentStart / SubagentStop 事件。

**逻辑**：
1. 从 stdin 读取 JSON（包含 `hook_event_name`、`cwd`、事件特定字段）
2. 读取环境变量 `CC_IM_HOOK_PORT`（默认 18900）
3. POST 到 `http://127.0.0.1:{port}/watch-notify`，body 为精简后的事件数据
4. 2 秒超时，失败静默忽略
5. 始终 exit 0（不阻塞 Claude Code）

**请求体格式**：

```typescript
interface WatchNotifyRequest {
  cwd: string;
  eventName: 'PostToolUse' | 'Stop' | 'SubagentStart' | 'SubagentStop';
  sessionId?: string;
  // PostToolUse 字段
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: string;
  // Stop 字段
  lastAssistantMessage?: string;
  // SubagentStart/Stop 字段
  agentType?: string;
}
```

**注意**：此脚本不检查是否有人在监控，纯粹转发事件到服务端。由服务端决定是否有监控者。这样脚本保持极简，快速退出。

### 2. permission-server.ts（扩展）

在已有 HTTP 服务中新增：

**新增路由**：
- `POST /watch-notify`：接收 hook 通知

**新增导出函数**：
- `registerWatch(workDir, entry: WatchEntry): void` — 注册监控
- `unregisterWatch(workDir, chatId, threadId?): void` — 注销监控
- `getWatchEntries(workDir): WatchEntry[]` — 查询当前监控
- `getWatchStatus(chatId, threadId?): { workDir: string; level: string } | null` — 查询某聊天的监控状态

**`/watch-notify` 处理逻辑**：
1. 解析请求体，提取 `cwd`
2. 遍历 `watchMap`，找到所有 `cwd` 以 `workDir` 开头的条目（前缀匹配）
3. 对每个匹配的 `WatchEntry`，检查事件类型是否在其 `level` 范围内
4. 格式化消息，通过 `WatchNotifySender` 接口发送

**WatchNotifySender 接口**：
```typescript
export interface WatchNotifySender {
  sendWatchNotify(chatId: string, text: string, threadCtx?: ThreadContext): Promise<void>;
}
```

各平台注册 sender（与 PermissionSender 模式一致），在 event-handler 初始化时注册。

### 3. handler.ts（扩展）

新增 `handleWatch` 方法：

```
/watch          → 调用 getWatchStatus 查询并显示
/watch <level>  → 调用 registerWatch 注册
/watch off      → 调用 unregisterWatch 注销
```

dispatch 中注册：
```typescript
if (trimmed === '/watch' || trimmed.startsWith('/watch ')) {
  return this.handleWatch(chatId, userId, trimmed.slice(6).trim(), platform, threadCtx);
}
```

help 文本添加：
```
/watch [级别]   - 监控终端 Claude Code 状态
```

### 4. ensure-hook.ts（扩展）

在自动配置中添加新的 hook 注册：

```json
{
  "hooks": {
    "PreToolUse": [/* 已有 */],
    "PostToolUse": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "<project>/dist/hook/watch-script.js" }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "<project>/dist/hook/watch-script.js" }]
    }],
    "SubagentStart": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "<project>/dist/hook/watch-script.js" }]
    }],
    "SubagentStop": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "<project>/dist/hook/watch-script.js" }]
    }]
  }
}
```

`matcher` 为空字符串表示匹配所有。

---

## 消息格式

### 工具完成（PostToolUse）

```
🔧 [工具名] 摘要
```

示例：
```
🔧 Bash: npm test
🔧 Write: src/index.ts
🔧 Edit: src/config.ts:45
🔧 Read: package.json
```

工具输入摘要复用已有的 `buildInputSummary` 函数（`src/shared/utils.ts`），截断到 100 字符。

### 任务完成（Stop）

```
✅ Claude 已完成
> 最后一条消息的前 200 字符...
```

### 子代理（SubagentStart/SubagentStop）

```
🤖 子代理启动: explore
🤖 子代理完成: explore
```

---

## cwd 匹配逻辑

终端 Claude Code 的 `cwd` 可能是监控工作区的子目录。匹配规则：

```typescript
function findWatchEntries(cwd: string, watchMap: WatchMap): WatchEntry[] {
  const entries: WatchEntry[] = [];
  for (const [workDir, watchers] of watchMap) {
    if (cwd === workDir || cwd.startsWith(workDir + '/')) {
      entries.push(...watchers);
    }
  }
  return entries;
}
```

---

## 错误处理

| 场景 | 处理 |
|------|------|
| watch-script 服务不可达 | 静默退出（exit 0），不影响终端 |
| watch-script 超时（>2s） | 中断请求，静默退出 |
| `/watch tool` 重复发送 | 更新 level，不重复注册 |
| 发送通知失败 | 日志记录，不影响其他监控者 |
| cc-im 重启 | watchMap 清空，用户需重新 `/watch` |

---

## 测试计划

### watch-script 测试
1. 正确解析 stdin 中的 PostToolUse 事件并发送请求
2. 正确解析 Stop 事件
3. 服务不可达时静默退出（exit 0）
4. 超时时静默退出

### permission-server 扩展测试
1. `/watch-notify` 按 cwd 前缀匹配
2. 按 level 过滤事件类型（stop 级别不转发 PostToolUse）
3. 多个监控者同时收到通知
4. registerWatch / unregisterWatch 增删正确
5. 重复注册同一 chatId 时更新 level

### handler 测试
1. `/watch` 显示当前状态
2. `/watch tool` 注册监控
3. `/watch off` 注销监控
4. `/watch invalid` 错误提示

### ensure-hook 测试
1. 新 hook 类型正确注册到 settings.json
