# /watch 命令实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过 `/watch` 命令实现终端 Claude Code 运行状态的实时监控，推送到聊天平台

**Architecture:** 新增 `watch-script.ts` hook 脚本处理 PostToolUse/Stop/SubagentStart/SubagentStop 事件；扩展 `permission-server.ts` 添加 watchMap 管理和 `/watch-notify` 端点；在 `handler.ts` 中注册 `/watch` 命令；扩展 `ensure-hook.ts` 自动注册新 hook 事件。

**Tech Stack:** TypeScript, Node.js HTTP, Vitest

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/hook/watch-script.ts` | 新建 | hook 脚本，转发事件到 cc-im |
| `src/hook/watch.ts` | 新建 | watchMap 管理 + 消息格式化 |
| `src/hook/permission-server.ts` | 修改 | 新增 `/watch-notify` 路由 |
| `src/hook/ensure-hook.ts` | 修改 | 注册 PostToolUse/Stop/SubagentStart/SubagentStop hook |
| `src/commands/handler.ts` | 修改 | 新增 `/watch` 命令 |
| `src/constants.ts` | 修改 | 新增 WATCH_NOTIFY_TIMEOUT_MS |
| `tests/unit/hook/watch.test.ts` | 新建 | watchMap + 格式化测试 |
| `tests/unit/commands/handler.test.ts` | 修改 | /watch 命令测试 |

---

## Chunk 1: watchMap 管理模块 + watch-script

### Task 1: watch.ts — watchMap 管理与消息格式化

**Files:**
- Create: `src/hook/watch.ts`
- Create: `tests/unit/hook/watch.test.ts`

- [ ] **Step 1: 写测试 — watchMap 增删查**

`tests/unit/hook/watch.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerWatch, unregisterWatch, getWatchEntries,
  getWatchStatus, clearAllWatches,
  formatWatchNotify, type WatchEntry, type WatchLevel,
} from '../../../src/hook/watch.js';

beforeEach(() => {
  clearAllWatches();
});

describe('watchMap management', () => {
  const entry: WatchEntry = { chatId: 'chat1', platform: 'feishu', level: 'tool' };

  it('registerWatch adds entry', () => {
    registerWatch('/work', entry);
    expect(getWatchEntries('/work')).toEqual([entry]);
  });

  it('registerWatch updates level for same chatId', () => {
    registerWatch('/work', entry);
    registerWatch('/work', { ...entry, level: 'full' });
    const entries = getWatchEntries('/work');
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('full');
  });

  it('registerWatch allows multiple chatIds for same workDir', () => {
    registerWatch('/work', entry);
    registerWatch('/work', { chatId: 'chat2', platform: 'telegram', level: 'stop' });
    expect(getWatchEntries('/work')).toHaveLength(2);
  });

  it('unregisterWatch removes entry by chatId', () => {
    registerWatch('/work', entry);
    unregisterWatch('/work', 'chat1');
    expect(getWatchEntries('/work')).toHaveLength(0);
  });

  it('unregisterWatch with threadId only removes matching entry', () => {
    const withThread: WatchEntry = { ...entry, threadCtx: { rootMessageId: 'rm1', threadId: 'th1' } };
    const withoutThread: WatchEntry = { chatId: 'chat1', platform: 'feishu', level: 'tool' };
    registerWatch('/work', withThread);
    registerWatch('/work', withoutThread);
    unregisterWatch('/work', 'chat1', 'th1');
    expect(getWatchEntries('/work')).toHaveLength(1);
    expect(getWatchEntries('/work')[0].threadCtx).toBeUndefined();
  });

  it('getWatchStatus returns status for chatId', () => {
    registerWatch('/work', entry);
    expect(getWatchStatus('chat1')).toEqual({ workDir: '/work', level: 'tool' });
  });

  it('getWatchStatus returns null when not watching', () => {
    expect(getWatchStatus('chat1')).toBeNull();
  });
});

describe('cwd prefix matching', () => {
  it('exact match', () => {
    registerWatch('/work/project', { chatId: 'c1', platform: 'feishu', level: 'tool' });
    expect(getWatchEntries('/work/project')).toHaveLength(1);
  });

  it('subdirectory match', () => {
    registerWatch('/work/project', { chatId: 'c1', platform: 'feishu', level: 'tool' });
    expect(getWatchEntries('/work/project/src')).toHaveLength(1);
  });

  it('no match for partial prefix', () => {
    registerWatch('/work/project', { chatId: 'c1', platform: 'feishu', level: 'tool' });
    expect(getWatchEntries('/work/project2')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 写测试 — 事件级别过滤**

追加到 `tests/unit/hook/watch.test.ts`:

```typescript
describe('level filtering', () => {
  it('stop level only includes Stop events', () => {
    registerWatch('/work', { chatId: 'c1', platform: 'feishu', level: 'stop' });
    expect(getWatchEntries('/work', 'PostToolUse')).toHaveLength(0);
    expect(getWatchEntries('/work', 'Stop')).toHaveLength(1);
    expect(getWatchEntries('/work', 'SubagentStart')).toHaveLength(0);
  });

  it('tool level includes PostToolUse and Stop', () => {
    registerWatch('/work', { chatId: 'c1', platform: 'feishu', level: 'tool' });
    expect(getWatchEntries('/work', 'PostToolUse')).toHaveLength(1);
    expect(getWatchEntries('/work', 'Stop')).toHaveLength(1);
    expect(getWatchEntries('/work', 'SubagentStart')).toHaveLength(0);
  });

  it('full level includes all events', () => {
    registerWatch('/work', { chatId: 'c1', platform: 'feishu', level: 'full' });
    expect(getWatchEntries('/work', 'PostToolUse')).toHaveLength(1);
    expect(getWatchEntries('/work', 'Stop')).toHaveLength(1);
    expect(getWatchEntries('/work', 'SubagentStart')).toHaveLength(1);
    expect(getWatchEntries('/work', 'SubagentStop')).toHaveLength(1);
  });
});
```

- [ ] **Step 3: 写测试 — 消息格式化**

追加到 `tests/unit/hook/watch.test.ts`:

```typescript
describe('formatWatchNotify', () => {
  it('formats PostToolUse', () => {
    const msg = formatWatchNotify({
      hookEventName: 'PostToolUse',
      toolName: 'Bash',
      toolInput: { command: 'npm test' },
    });
    expect(msg).toContain('🔧');
    expect(msg).toContain('Bash');
    expect(msg).toContain('npm test');
  });

  it('formats Stop with last message', () => {
    const msg = formatWatchNotify({
      hookEventName: 'Stop',
      lastMessage: '已完成所有测试修复。',
    });
    expect(msg).toContain('✅');
    expect(msg).toContain('已完成所有测试修复');
  });

  it('formats SubagentStart', () => {
    const msg = formatWatchNotify({
      hookEventName: 'SubagentStart',
      agentType: 'Explore',
    });
    expect(msg).toContain('🤖');
    expect(msg).toContain('Explore');
  });

  it('truncates long last message to 200 chars', () => {
    const msg = formatWatchNotify({
      hookEventName: 'Stop',
      lastMessage: 'x'.repeat(300),
    });
    expect(msg.length).toBeLessThan(250);
    expect(msg).toContain('...');
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm test -- tests/unit/hook/watch.test.ts`
Expected: FAIL — module 不存在

- [ ] **Step 5: 实现 watch.ts**

`src/hook/watch.ts`:

```typescript
import type { ThreadContext } from '../shared/types.js';
import type { Platform } from '../config.js';

export type WatchLevel = 'stop' | 'tool' | 'full';

export type WatchEventName = 'PostToolUse' | 'Stop' | 'SubagentStart' | 'SubagentStop';

export interface WatchEntry {
  chatId: string;
  platform: Platform;
  threadCtx?: ThreadContext;
  level: WatchLevel;
}

interface WatchNotifyData {
  hookEventName: WatchEventName;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  lastMessage?: string;
  agentType?: string;
}

const LEVEL_EVENTS: Record<WatchLevel, Set<WatchEventName>> = {
  stop: new Set(['Stop']),
  tool: new Set(['PostToolUse', 'Stop']),
  full: new Set(['PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']),
};

const watchMap = new Map<string, WatchEntry[]>();

export function registerWatch(workDir: string, entry: WatchEntry): void {
  let entries = watchMap.get(workDir);
  if (!entries) {
    entries = [];
    watchMap.set(workDir, entries);
  }
  // 同一 chatId + threadId 更新 level
  const threadId = entry.threadCtx?.threadId;
  const idx = entries.findIndex(e =>
    e.chatId === entry.chatId && e.threadCtx?.threadId === threadId
  );
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
}

export function unregisterWatch(workDir: string, chatId: string, threadId?: string): void {
  const entries = watchMap.get(workDir);
  if (!entries) return;
  const filtered = entries.filter(e =>
    !(e.chatId === chatId && e.threadCtx?.threadId === threadId)
  );
  if (filtered.length === 0) {
    watchMap.delete(workDir);
  } else {
    watchMap.set(workDir, filtered);
  }
}

export function getWatchEntries(cwd: string, eventName?: WatchEventName): WatchEntry[] {
  const result: WatchEntry[] = [];
  for (const [workDir, entries] of watchMap) {
    if (cwd === workDir || cwd.startsWith(workDir + '/')) {
      for (const e of entries) {
        if (!eventName || LEVEL_EVENTS[e.level].has(eventName)) {
          result.push(e);
        }
      }
    }
  }
  return result;
}

export function getWatchStatus(chatId: string, threadId?: string): { workDir: string; level: WatchLevel } | null {
  for (const [workDir, entries] of watchMap) {
    for (const e of entries) {
      if (e.chatId === chatId && e.threadCtx?.threadId === threadId) {
        return { workDir, level: e.level };
      }
    }
  }
  return null;
}

export function clearAllWatches(): void {
  watchMap.clear();
}

function formatToolSummary(toolName: string, toolInput?: Record<string, unknown>): string {
  if (!toolInput) return toolName;
  if (toolName === 'Bash' && toolInput.command) {
    const cmd = String(toolInput.command);
    return `${toolName}: ${cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd}`;
  }
  if ((toolName === 'Write' || toolName === 'Edit') && toolInput.file_path) {
    return `${toolName}: ${toolInput.file_path}`;
  }
  if (toolName === 'Read' && toolInput.file_path) {
    return `${toolName}: ${toolInput.file_path}`;
  }
  return toolName;
}

export function formatWatchNotify(data: WatchNotifyData): string {
  switch (data.hookEventName) {
    case 'PostToolUse': {
      const summary = formatToolSummary(data.toolName ?? 'unknown', data.toolInput);
      return `🔧 ${summary}`;
    }
    case 'Stop': {
      const msg = data.lastMessage ?? '';
      const preview = msg.length > 200 ? msg.slice(0, 197) + '...' : msg;
      return preview ? `✅ Claude 已完成\n> ${preview}` : '✅ Claude 已完成';
    }
    case 'SubagentStart':
      return `🤖 子代理启动: ${data.agentType ?? 'unknown'}`;
    case 'SubagentStop':
      return `🤖 子代理完成: ${data.agentType ?? 'unknown'}`;
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm test -- tests/unit/hook/watch.test.ts`
Expected: PASS

- [ ] **Step 7: 构建检查**

Run: `pnpm build`
Expected: 无编译错误

- [ ] **Step 8: 提交**

```bash
git add src/hook/watch.ts tests/unit/hook/watch.test.ts
git commit -m "feat: 添加 watchMap 管理模块与消息格式化"
```

### Task 2: watch-script.ts — Hook 脚本

**Files:**
- Create: `src/hook/watch-script.ts`

- [ ] **Step 1: 实现 watch-script.ts**

`src/hook/watch-script.ts`:

```typescript
#!/usr/bin/env node

/**
 * Claude Code watch hook script.
 *
 * Handles PostToolUse / Stop / SubagentStart / SubagentStop events.
 * Forwards event data to cc-im's /watch-notify endpoint.
 * Always exits 0 — never blocks Claude Code.
 *
 * Environment variables:
 *   CC_IM_HOOK_PORT - Port of the local cc-im server (default: 18900)
 *
 * stdin: JSON with hook_event_name, cwd, and event-specific fields
 */

import { request } from 'node:http';

const WATCH_NOTIFY_TIMEOUT_MS = 2000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 100);
  });
}

function httpPost(port: number, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: '/watch-notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: WATCH_NOTIFY_TIMEOUT_MS,
    }, () => resolve());
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  const port = parseInt(process.env.CC_IM_HOOK_PORT ?? '18900', 10);

  let input: Record<string, unknown>;
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    process.exit(0);
  }

  const hookEventName = input.hook_event_name as string;
  const cwd = (input.cwd as string) ?? process.cwd();

  if (!hookEventName) {
    process.exit(0);
  }

  await httpPost(port, {
    cwd,
    hookEventName,
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolResponse: input.tool_response,
    lastMessage: (input as Record<string, unknown>).last_assistant_message,
    agentType: (input as Record<string, unknown>).agent_type,
  });

  process.exit(0);
}

const isDirectRun = process.argv[1]?.endsWith('watch-script.js');
if (isDirectRun) main();

export { main, readStdin };
```

- [ ] **Step 2: 构建检查**

Run: `pnpm build`
Expected: 无编译错误

- [ ] **Step 3: 提交**

```bash
git add src/hook/watch-script.ts
git commit -m "feat: 添加 watch-script.ts hook 脚本"
```

---

## Chunk 2: 服务端集成 + 命令注册

### Task 3: permission-server.ts — /watch-notify 端点

**Files:**
- Modify: `src/hook/permission-server.ts`

- [ ] **Step 1: 添加 WatchNotifySender 接口和注册**

在 `permission-server.ts` 中添加：

```typescript
import {
  getWatchEntries, formatWatchNotify,
  type WatchEventName,
} from './watch.js';

export interface WatchNotifySender {
  sendWatchNotify(chatId: string, text: string, threadCtx?: ThreadContext): Promise<void>;
}

const watchSenders = new Map<string, WatchNotifySender>();

export function registerWatchSender(platform: string, s: WatchNotifySender) {
  watchSenders.set(platform, s);
}
```

- [ ] **Step 2: 在 handleRequest 中添加 /watch-notify 路由**

在 `handleRequest` 函数中（`/health` 之前）添加：

```typescript
if (req.method === 'POST' && url.pathname === '/watch-notify') {
  try {
    const body = JSON.parse(await readBody(req));
    const { cwd, hookEventName } = body;
    if (!cwd || !hookEventName) {
      sendJson(res, 400, { error: 'cwd and hookEventName required' });
      return;
    }
    const entries = getWatchEntries(cwd, hookEventName as WatchEventName);
    if (entries.length === 0) {
      sendJson(res, 200, { sent: 0 });
      return;
    }
    const message = formatWatchNotify(body);
    let sent = 0;
    for (const entry of entries) {
      const sender = watchSenders.get(entry.platform);
      if (sender) {
        sender.sendWatchNotify(entry.chatId, message, entry.threadCtx).catch((err) => {
          log.warn(`Failed to send watch notify to ${entry.chatId}:`, err);
        });
        sent++;
      }
    }
    sendJson(res, 200, { sent });
  } catch (err) {
    log.error('Error handling watch notify:', err);
    sendJson(res, 500, { error: 'Internal error' });
  }
  return;
}
```

- [ ] **Step 3: 构建检查**

Run: `pnpm build`
Expected: 无编译错误

- [ ] **Step 4: 提交**

```bash
git add src/hook/permission-server.ts
git commit -m "feat: permission-server 添加 /watch-notify 端点"
```

### Task 4: 各平台注册 WatchNotifySender

**Files:**
- Modify: `src/feishu/event-handler.ts`
- Modify: `src/telegram/event-handler.ts`
- Modify: `src/wecom/event-handler.ts`

- [ ] **Step 1: 飞书注册**

在 `src/feishu/event-handler.ts` 中，找到 `registerPermissionSender` 调用处，在其后添加：

```typescript
import { registerWatchSender } from '../hook/permission-server.js';

// 在初始化阶段（registerPermissionSender 之后）
registerWatchSender('feishu', {
  sendWatchNotify: (chatId, text, threadCtx) => sender.sendTextReply(chatId, text, threadCtx),
});
```

- [ ] **Step 2: Telegram 注册**

在 `src/telegram/event-handler.ts` 中，`registerPermissionSender` 附近添加：

```typescript
import { registerWatchSender } from '../hook/permission-server.js';

registerWatchSender('telegram', {
  sendWatchNotify: (chatId, text) => sender.sendTextReply(chatId, text),
});
```

- [ ] **Step 3: 企业微信注册**

在 `src/wecom/event-handler.ts` 中，`registerPermissionSender` 附近添加：

```typescript
import { registerWatchSender } from '../hook/permission-server.js';
import { sendTextReply as wecomSendText } from './message-sender.js';

registerWatchSender('wecom', {
  sendWatchNotify: (chatId, text) => wecomSendText(chatId, text),
});
```

- [ ] **Step 4: 构建检查**

Run: `pnpm build`
Expected: 无编译错误

- [ ] **Step 5: 提交**

```bash
git add src/feishu/event-handler.ts src/telegram/event-handler.ts src/wecom/event-handler.ts
git commit -m "feat: 各平台注册 WatchNotifySender"
```

### Task 5: handler.ts — /watch 命令

**Files:**
- Modify: `src/commands/handler.ts`
- Modify: `tests/unit/commands/handler.test.ts`

- [ ] **Step 1: 写测试**

在 `tests/unit/commands/handler.test.ts` 中添加：

```typescript
// ─── /watch ───

describe('handleWatch', () => {
  it('should route /watch in dispatch', async () => {
    const result = await handler.dispatch('/watch', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(result).toBe(true);
  });

  it('should show "not watching" when no active watch', async () => {
    await handler.dispatch('/watch', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('未开启'),
      undefined,
    );
  });

  it('should register watch with valid level', async () => {
    await handler.dispatch('/watch tool', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('tool'),
      undefined,
    );
  });

  it('should unregister watch with /watch off', async () => {
    await handler.dispatch('/watch tool', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    vi.mocked(deps.sender.sendTextReply).mockClear();
    await handler.dispatch('/watch off', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('已关闭'),
      undefined,
    );
  });

  it('should reject invalid level', async () => {
    await handler.dispatch('/watch invalid', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('无效'),
      undefined,
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- tests/unit/commands/handler.test.ts`
Expected: FAIL — /watch 未注册

- [ ] **Step 3: 实现 handleWatch**

在 `src/commands/handler.ts` 中：

1. 添加 import：
```typescript
import { registerWatch, unregisterWatch, getWatchStatus, type WatchLevel } from '../hook/watch.js';
```

2. 在 dispatch 中注册（在 `/resume` 之后）：
```typescript
if (trimmed === '/watch' || trimmed.startsWith('/watch ')) {
  return this.handleWatch(chatId, userId, trimmed.slice(6).trim(), platform, threadCtx);
}
```

3. 添加 handleWatch 方法：
```typescript
async handleWatch(chatId: string, userId: string, args: string, platform: Platform, threadCtx?: ThreadContext): Promise<boolean> {
  const workDir = threadCtx
    ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
    : this.deps.sessionManager.getWorkDir(userId);
  const threadId = threadCtx?.threadId;

  if (!args) {
    const status = getWatchStatus(chatId, threadId);
    if (status) {
      await this.deps.sender.sendTextReply(chatId, `📡 监控中 [${status.level}]\n工作区: ${status.workDir}`, threadCtx);
    } else {
      await this.deps.sender.sendTextReply(chatId, '📡 未开启监控\n\n使用 /watch <级别> 开启：\n  stop - 仅完成事件\n  tool - 工具调用 + 完成\n  full - 全量（含子代理）', threadCtx);
    }
    return true;
  }

  if (args === 'off') {
    unregisterWatch(workDir, chatId, threadId);
    await this.deps.sender.sendTextReply(chatId, '📡 已关闭监控', threadCtx);
    return true;
  }

  const validLevels: WatchLevel[] = ['stop', 'tool', 'full'];
  if (!validLevels.includes(args as WatchLevel)) {
    await this.deps.sender.sendTextReply(chatId, `无效的监控级别: ${args}\n可选: stop / tool / full / off`, threadCtx);
    return true;
  }

  registerWatch(workDir, { chatId, platform, threadCtx, level: args as WatchLevel });
  await this.deps.sender.sendTextReply(chatId, `📡 已开启监控 [${args}]\n工作区: ${workDir}\n\n在此工作区启动的终端 Claude Code 的事件将推送到此处。\n使用 /watch off 关闭`, threadCtx);
  return true;
}
```

4. 在 `/help` 文本中添加（`/resume` 行之后）：
```typescript
'/watch [级别]   - 监控终端 Claude Code 状态',
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- tests/unit/commands/handler.test.ts`
Expected: PASS

- [ ] **Step 5: 构建检查**

Run: `pnpm build`
Expected: 无编译错误

- [ ] **Step 6: 提交**

```bash
git add src/commands/handler.ts tests/unit/commands/handler.test.ts
git commit -m "feat: 添加 /watch 命令"
```

### Task 6: ensure-hook.ts — 注册新 hook 事件

**Files:**
- Modify: `src/hook/ensure-hook.ts`
- Modify: `tests/unit/hook/ensure-hook.test.ts`

- [ ] **Step 1: 查看现有 ensure-hook 测试模式**

读取 `tests/unit/hook/ensure-hook.test.ts` 了解测试结构。

- [ ] **Step 2: 添加测试**

添加测试验证 watch hook 事件被正确注册到 settings.json。

- [ ] **Step 3: 实现**

修改 `ensureHookConfigured()` 以同时注册 watch hook 事件：

在现有 PreToolUse 处理后，添加对 PostToolUse / Stop / SubagentStart / SubagentStop 的处理。

关键变更：
1. 新增 `getWatchScriptPath()` 函数（类似 `getHookScriptPath()`，指向 `dist/hook/watch-script.js`）
2. 对每个 watch 事件类型（PostToolUse / Stop / SubagentStart / SubagentStop），检查是否已注册，未注册则自动添加
3. watch hook 的 matcher 为空字符串（匹配所有）

```typescript
const WATCH_EVENTS = ['PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'];

function getWatchScriptPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = dirname(dirname(dirname(thisFile)));
  return join(projectRoot, 'dist', 'hook', 'watch-script.js');
}

// 在 ensureHookConfigured() 中，PreToolUse 处理之后：
const watchScriptPath = getWatchScriptPath();
if (existsSync(watchScriptPath)) {
  for (const eventName of WATCH_EVENTS) {
    const eventHooks = (hooks[eventName] ?? []) as HookEntry[];
    const hasOurHook = eventHooks.some(entry =>
      entry.hooks?.some(h => isOurHook(h.command, watchScriptPath))
    );
    if (!hasOurHook) {
      eventHooks.push({
        matcher: '',
        hooks: [{ type: 'command', command: watchScriptPath }],
      });
      hooks[eventName] = eventHooks;
      needsWrite = true;
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- tests/unit/hook/ensure-hook.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全部测试**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 6: 构建检查**

Run: `pnpm build`
Expected: 无编译错误

- [ ] **Step 7: 提交**

```bash
git add src/hook/ensure-hook.ts tests/unit/hook/ensure-hook.test.ts
git commit -m "feat: ensure-hook 自动注册 watch hook 事件"
```

---

## Chunk 3: 文档更新

### Task 7: 文档更新

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 CLAUDE.md**

在命令分类中添加 `/watch`：
```
- 会话管理：`/new`、`/compact`、`/resume`
- 监控：`/watch`
```

在权限系统配置部分说明 watch hook 的自动注册。

- [ ] **Step 2: 更新 CHANGELOG.md**

在 `## [Unreleased]` 添加：
```
### 新功能
- `/watch` 命令：实时监控终端 Claude Code 的运行状态，支持 stop/tool/full 三个级别
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: 更新文档记录 /watch 命令"
```
