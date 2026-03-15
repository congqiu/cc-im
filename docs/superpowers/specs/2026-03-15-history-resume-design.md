# /history 优化 + /resume 新命令 设计方案

## 背景

当前 `/history` 功能鸡肋：只能看当前会话记录，无时间戳，默认从头开始显示，消息被截断。且没有办法浏览和恢复历史会话。

## 设计目标

1. `/history` 优化为完整的当前会话查看器
2. `/resume` 作为新命令，提供会话列表浏览和恢复能力

---

## 命令设计

### /history — 当前会话聊天记录

**用法**：
```
/history        → 显示当前会话最新消息（最后一页）
/history 1      → 显示当前会话第 1 页（最早的消息）
```

**改动点**（相对现有实现）：

| 项目 | 现状 | 改为 |
|------|------|------|
| 默认页码 | 第 1 页（最早） | 最后一页（最新） |
| 时间戳 | 不显示 | 每条消息前显示时间 |
| 消息截断 | 超 300 字截断 | 完整展示，不截断 |
| 翻页提示 | 只有"下一页" | 同时显示"上一页"和"下一页" |

**输出格式**：
```
📜 会话历史 (3/3) — a1b2c3d4

[14:30] 👤 帮我把 /history 功能优化一下，现在感觉有点弱和鸡肋

[14:31] 🤖 先看看当前 /history 的实现。
（完整消息内容，不截断）

使用 /history 2 查看上一页
```

**实现变更**：

修改 `src/shared/history.ts`：

1. `getHistory()` — 新增逻辑：当 `page` 参数未指定时（传入 0 或负数），自动计算为最后一页
2. `formatHistoryPage()` — 每条消息前加时间戳（格式 `[HH:mm]` 或 `[MM-DD HH:mm]`，当天只显示时间，非当天显示日期+时间），移除 300 字截断，翻页提示包含上一页/下一页

修改 `src/commands/handler.ts`：

1. `handleHistory()` — 参数解析：无参数时传 page=0 表示"最后一页"

### /resume — 会话列表与恢复

**用法**：
```
/resume         → 显示当前工作区的会话列表（最近 10 条）
/resume 3       → 恢复第 3 个会话
```

**会话列表输出格式**：
```
📋 会话列表 (当前工作区)

1. 03-15 14:30 | 8条  | 帮我把 /history 功能优化一下，现在感觉有点弱和鸡肋
2. 03-14 09:15 | 23条 | 添加企业微信平台支持，使用 @wecom/aibot-node-sdk WebSocket 长连接接入
3. 03-13 18:42 | 5条  | 修复飞书卡片闪烁问题
   ▶ 当前会话

使用 /resume <序号> 恢复会话
```

**列表数据来源**：

扫描 `~/.claude/projects/<encoded-workdir>/` 下的 `.jsonl` 文件，按修改时间倒序，取最近 10 条。对每个文件：
- 读取文件 stat 获取修改时间（用于排序和显示）
- 解析首条 user 消息作为预览（截断到 100 字符，仅列表预览用）
- 统计 user + assistant 消息条数
- 与当前 sessionId 比较，标记当前会话

**恢复逻辑**（`/resume <n>`）：

1. 获取会话列表，根据序号找到目标 sessionId
2. 调用 SessionManager 的恢复逻辑：
   - 将当前 convId + sessionId 转存到 `convSessionMap`（与 `/new` 相同）
   - 生成新 convId
   - 将 sessionId 设为目标会话的 ID
   - 重置 totalTurns 为 0
3. 回复确认消息

**实现位置**：

新增函数到 `src/shared/history.ts`：
- `getSessionList(workDir: string, currentSessionId?: string): Promise<SessionListResult>` — 获取会话列表

新增方法到 `src/commands/handler.ts`：
- `handleResume(chatId, userId, args, threadCtx)` — 处理 /resume 命令

新增方法到 `src/session/session-manager.ts`：
- `resumeSession(userId: string, sessionId: string): void` — 恢复到指定会话（转存旧 convId、生成新 convId、设置目标 sessionId）

---

## 命令注册

在 `handler.ts` 的 dispatch 中注册 `/resume`，在 `/help` 输出中添加：
```
/history [页码]  - 查看当前会话聊天记录
/resume [序号]   - 浏览/恢复历史会话
```

---

## 错误处理

| 场景 | 处理 |
|------|------|
| `/resume 99`（超出范围） | "无效的序号 99，共 N 个会话。" |
| `/resume 0` | "无效的序号，请使用 /resume 查看会话列表。" |
| 工作区无会话文件 | "当前工作区未找到会话记录。" |
| `/resume` 在话题中 | 正常工作，使用话题的 workDir |
| 恢复当前已激活的会话 | "该会话已是当前会话。" |

---

## 测试计划

### history.ts 新增/修改测试

1. `getHistory()` page=0 时返回最后一页
2. `formatHistoryPage()` 消息带时间戳
3. `formatHistoryPage()` 消息不截断
4. `formatHistoryPage()` 翻页提示包含上一页
5. `getSessionList()` 返回按时间倒序的会话列表
6. `getSessionList()` 最多返回 10 条
7. `getSessionList()` 正确标记当前会话
8. `getSessionList()` 提取首条用户消息预览
9. `getSessionList()` 统计消息数量

### handler.test.ts 新增测试

1. `/resume` 无参数显示会话列表
2. `/resume 3` 恢复指定会话
3. `/resume 99` 超出范围报错
4. `/resume 0` 无效序号报错
5. `/history` 无参数显示最后一页
6. `/history 1` 显示第一页

### session-manager 测试

1. `resumeSession()` 转存旧 convId
2. `resumeSession()` 设置新 sessionId
3. `resumeSession()` 生成新 convId
