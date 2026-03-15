# /history 优化 + /resume 新命令 实现计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化 `/history` 命令（时间戳、默认最后一页、不截断），新增 `/resume` 命令（会话列表浏览与恢复）

**Architecture:** 在 `src/shared/history.ts` 中扩展 `getHistory` 并新增 `getSessionList`/`formatSessionList`；在 `session-manager.ts` 中新增 `resumeSession`；在 `handler.ts` 中注册 `/resume` 命令并更新 `/history` 的默认行为。TDD，先测试后实现。

**Tech Stack:** TypeScript, Vitest, Node.js fs/promises

---

## Chunk 1: /history 优化

### Task 1: getHistory 支持 page=0 表示最后一页

**Files:**
- Modify: `src/shared/history.ts:82-83`
- Test: `tests/unit/shared/history.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/unit/shared/history.test.ts` 的 `分页` describe 中添加：

```typescript
it('page=0 时返回最后一页', async () => {
  mockReadFile.mockResolvedValue(manyEntries(25));

  const result = await getHistory(workDir, 'sess', 0);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.page).toBe(3);
  expect(result.data.totalPages).toBe(3);
  expect(result.data.entries).toHaveLength(5);
  expect(result.data.entries[0].text).toBe('msg-20');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- tests/unit/shared/history.test.ts`
Expected: FAIL — page=0 被 clamp 到 1 而不是 3

- [ ] **Step 3: 实现 page=0 逻辑**

修改 `src/shared/history.ts` 第 82-83 行：

```typescript
// 旧代码：
const totalPages = Math.ceil(entries.length / PAGE_SIZE);
const p = Math.max(1, Math.min(page, totalPages));

// 新代码：
const totalPages = Math.ceil(entries.length / PAGE_SIZE);
const p = page <= 0 ? totalPages : Math.max(1, Math.min(page, totalPages));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- tests/unit/shared/history.test.ts`
Expected: PASS

### Task 2: formatHistoryPage 添加时间戳、移除截断、双向翻页

**Files:**
- Modify: `src/shared/history.ts:90-101`
- Test: `tests/unit/shared/history.test.ts`

- [ ] **Step 1: 写失败测试 — 时间戳显示**

在 `formatHistoryPage` describe 中添加：

```typescript
it('消息前显示时间戳', () => {
  const page: HistoryPage = {
    entries: [
      { role: 'user', text: 'hello', timestamp: '2026-03-15T14:30:00Z' },
      { role: 'assistant', text: 'hi', timestamp: '2026-03-15T14:31:00Z' },
    ],
    page: 1,
    totalPages: 1,
    sessionId: 'sess12345678',
  };

  const output = formatHistoryPage(page);

  // 时间戳格式 [MM-DD HH:mm] 或 [HH:mm]
  expect(output).toMatch(/\[\d{2}[:-]\d{2}\s*\d{0,2}:?\d{0,2}\]/);
  expect(output).toContain('👤');
  expect(output).toContain('hello');
});
```

- [ ] **Step 2: 写失败测试 — 消息不截断**

替换现有的 "截断超过 300 字符的消息" 测试：

```typescript
it('消息完整展示不截断', () => {
  const longText = 'x'.repeat(400);
  const page: HistoryPage = {
    entries: [{ role: 'user', text: longText, timestamp: '2026-03-15T14:30:00Z' }],
    page: 1,
    totalPages: 1,
    sessionId: 'sess12345678',
  };

  const output = formatHistoryPage(page);

  expect(output).toContain(longText);
  expect(output).not.toContain('...');
});
```

- [ ] **Step 3: 写失败测试 — 上一页提示**

```typescript
it('非首页时显示上一页提示', () => {
  const page: HistoryPage = {
    entries: [{ role: 'user', text: 'msg', timestamp: '2026-03-15T14:30:00Z' }],
    page: 2,
    totalPages: 3,
    sessionId: 'sess12345678',
  };

  const output = formatHistoryPage(page);

  expect(output).toContain('/history 1');
  expect(output).toContain('/history 3');
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm test -- tests/unit/shared/history.test.ts`
Expected: FAIL

- [ ] **Step 5: 实现 formatHistoryPage 改动**

修改 `src/shared/history.ts` 的 `formatHistoryPage` 函数：

```typescript
function formatTimestamp(ts?: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return `[${time}]`;
    }
    return `[${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}]`;
  } catch {
    return '';
  }
}

export function formatHistoryPage(result: HistoryPage): string {
  const lines = [`📜 会话历史 (${result.page}/${result.totalPages}) — ${result.sessionId.slice(-8)}`, ''];
  for (const e of result.entries) {
    const prefix = e.role === 'user' ? '👤' : '🤖';
    const ts = formatTimestamp(e.timestamp);
    lines.push(`${ts} ${prefix} ${e.text}`);
  }
  const nav: string[] = [];
  if (result.page > 1) nav.push(`/history ${result.page - 1} 上一页`);
  if (result.page < result.totalPages) nav.push(`/history ${result.page + 1} 下一页`);
  if (nav.length > 0) lines.push('', nav.join('  |  '));
  return lines.join('\n');
}
```

- [ ] **Step 6: 更新受影响的旧测试**

以下旧测试需要适配新的格式（时间戳、不截断、翻页提示变化）：
- "正确格式化带 user/assistant 前缀" — entries 需要加 timestamp 字段
- "不足 300 字符的消息不截断" — 移除或合并到新测试
- "截断超过 300 字符的消息" — 替换为"消息完整展示不截断"
- "有下一页时显示翻页提示" — entries 加 timestamp
- "最后一页不显示翻页提示" — entries 加 timestamp
- "单页不显示翻页提示" — entries 加 timestamp

- [ ] **Step 7: 运行测试确认全部通过**

Run: `pnpm test -- tests/unit/shared/history.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/shared/history.ts tests/unit/shared/history.test.ts
git commit -m "feat: /history 默认显示最后一页，添加时间戳，移除截断"
```

### Task 3: handleHistory 默认传 page=0

**Files:**
- Modify: `src/commands/handler.ts:407-408`
- Test: `tests/unit/commands/handler.test.ts`

- [ ] **Step 1: 写失败测试**

在 handler.test.ts 的 `handleHistory` describe 中修改现有测试和添加新测试：

```typescript
it('should default to last page when no args', async () => {
  // mock getHistory to capture the page argument
  const { getHistory } = await import('../../../src/shared/history.js');
  vi.mocked(getHistory).mockResolvedValue({
    ok: true,
    data: { entries: [{ role: 'user', text: 'msg', timestamp: '2026-03-15T00:00:00Z' }], page: 5, totalPages: 5, sessionId: 'sess' },
  });
  await handler.dispatch('/history', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
  expect(getHistory).toHaveBeenCalledWith(expect.any(String), expect.anything(), 0);
});
```

- [ ] **Step 2: 实现改动**

修改 `src/commands/handler.ts` 第 408 行：

```typescript
// 旧代码：
const page = parseInt(args, 10) || 1;

// 新代码：
const page = args ? (parseInt(args, 10) || 1) : 0;
```

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm test -- tests/unit/commands/handler.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/commands/handler.ts tests/unit/commands/handler.test.ts
git commit -m "feat: /history 无参数时默认显示最后一页"
```

---

## Chunk 2: /resume 命令 — 会话列表

### Task 4: getSessionList 函数

**Files:**
- Modify: `src/shared/history.ts`（新增函数和类型）
- Test: `tests/unit/shared/history.test.ts`

- [ ] **Step 1: 定义类型**

在 `src/shared/history.ts` 中添加导出类型：

```typescript
export interface SessionListItem {
  sessionId: string;
  mtime: number;           // 修改时间戳（毫秒）
  messageCount: number;    // user + assistant 消息数
  preview: string;         // 首条用户消息（截断到 100 字符）
  isCurrent: boolean;      // 是否为当前会话
}

export type SessionListResult =
  | { ok: true; data: SessionListItem[] }
  | { ok: false; error: string };
```

- [ ] **Step 2: 写失败测试 — 按时间倒序返回会话列表**

在 `tests/unit/shared/history.test.ts` 中添加新的 describe：

```typescript
describe('getSessionList', () => {
  const workDir = '/home/user/project';

  it('按时间倒序返回会话列表', async () => {
    mockReaddir.mockResolvedValue(['old.jsonl', 'new.jsonl'] as any);
    mockStat.mockImplementation(((p: string) => {
      if (String(p).includes('old.jsonl')) return Promise.resolve({ mtimeMs: 1000 });
      if (String(p).includes('new.jsonl')) return Promise.resolve({ mtimeMs: 2000 });
      return Promise.resolve({ mtimeMs: 0 });
    }) as any);
    mockReadFile.mockImplementation(((p: string) => {
      if (String(p).includes('old.jsonl')) return Promise.resolve(userLine('old message'));
      if (String(p).includes('new.jsonl')) return Promise.resolve(userLine('new message'));
      return Promise.resolve('');
    }) as any);

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0].sessionId).toBe('new');
    expect(result.data[1].sessionId).toBe('old');
  });

  it('最多返回 10 条', async () => {
    const files = Array.from({ length: 15 }, (_, i) => `sess-${i}.jsonl`);
    mockReaddir.mockResolvedValue(files as any);
    mockStat.mockImplementation(((p: string) => {
      const match = String(p).match(/sess-(\d+)/);
      return Promise.resolve({ mtimeMs: match ? parseInt(match[1]) * 1000 : 0 });
    }) as any);
    mockReadFile.mockResolvedValue(userLine('msg'));

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(10);
    // 最新的在前
    expect(result.data[0].sessionId).toBe('sess-14');
  });

  it('正确标记当前会话', async () => {
    mockReaddir.mockResolvedValue(['aaa.jsonl', 'bbb.jsonl'] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
    mockReadFile.mockResolvedValue(userLine('msg'));

    const result = await getSessionList(workDir, 'bbb');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const current = result.data.find(s => s.sessionId === 'bbb');
    expect(current?.isCurrent).toBe(true);
    const other = result.data.find(s => s.sessionId === 'aaa');
    expect(other?.isCurrent).toBe(false);
  });

  it('提取首条用户消息预览', async () => {
    const longMsg = 'x'.repeat(200);
    mockReaddir.mockResolvedValue(['sess.jsonl'] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
    mockReadFile.mockResolvedValue(userLine(longMsg));

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].preview.length).toBeLessThanOrEqual(103); // 100 + '...'
  });

  it('统计消息数量', async () => {
    const lines = [userLine('q1'), assistantLine('a1'), userLine('q2'), assistantLine('a2')].join('\n');
    mockReaddir.mockResolvedValue(['sess.jsonl'] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
    mockReadFile.mockResolvedValue(lines);

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].messageCount).toBe(4);
  });

  it('目录不存在时返回错误', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('未找到');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test -- tests/unit/shared/history.test.ts`
Expected: FAIL — `getSessionList` 不存在

- [ ] **Step 4: 实现 getSessionList**

在 `src/shared/history.ts` 中添加：

```typescript
const MAX_SESSION_LIST = 10;
const PREVIEW_LENGTH = 100;

function parseSessionFile(raw: string): { messageCount: number; preview: string } {
  let messageCount = 0;
  let preview = '';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg) continue;
      const text = extractText(msg.content).trim();
      if (!text) continue;
      if (text.startsWith('<local-command') || text.startsWith('<command-name>')) continue;
      messageCount++;
      if (!preview && msg.role === 'user') {
        preview = text.length > PREVIEW_LENGTH ? text.slice(0, PREVIEW_LENGTH) + '...' : text;
      }
    } catch { /* skip */ }
  }
  return { messageCount, preview };
}

export async function getSessionList(workDir: string, currentSessionId?: string): Promise<SessionListResult> {
  const projectDir = join(homedir(), '.claude', 'projects', encodeWorkDir(workDir));

  let files: string[];
  try {
    files = (await readdir(projectDir)).filter(f => f.endsWith('.jsonl'));
  } catch {
    return { ok: false, error: '当前工作区未找到会话记录。' };
  }
  if (files.length === 0) return { ok: false, error: '当前工作区未找到会话记录。' };

  // 获取 mtime 并按时间倒序排序
  const withMtime = await Promise.all(
    files.map(async f => ({
      f,
      mtime: (await stat(join(projectDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
    }))
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);

  // 取最近 10 条
  const recent = withMtime.slice(0, MAX_SESSION_LIST);

  const items: SessionListItem[] = await Promise.all(
    recent.map(async ({ f, mtime }) => {
      const sessionId = f.replace('.jsonl', '');
      let messageCount = 0;
      let preview = '';
      try {
        const raw = await readFile(join(projectDir, f), 'utf-8');
        ({ messageCount, preview } = parseSessionFile(raw));
      } catch { /* skip */ }
      return {
        sessionId,
        mtime,
        messageCount,
        preview: preview || '(空会话)',
        isCurrent: sessionId === currentSessionId,
      };
    })
  );

  return { ok: true, data: items };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test -- tests/unit/shared/history.test.ts`
Expected: PASS

- [ ] **Step 6: 添加 formatSessionList 函数和测试**

测试：

```typescript
describe('formatSessionList', () => {
  it('正确格式化会话列表', () => {
    const items: SessionListItem[] = [
      { sessionId: 'abc123', mtime: new Date('2026-03-15T14:30:00Z').getTime(), messageCount: 8, preview: '帮我优化 /history', isCurrent: false },
      { sessionId: 'def456', mtime: new Date('2026-03-14T09:15:00Z').getTime(), messageCount: 23, preview: '添加企业微信', isCurrent: true },
    ];

    const output = formatSessionList(items);

    expect(output).toContain('会话列表');
    expect(output).toContain('1.');
    expect(output).toContain('2.');
    expect(output).toContain('帮我优化 /history');
    expect(output).toContain('▶ 当前会话');
    expect(output).toContain('/resume');
  });
});
```

实现：

```typescript
export function formatSessionList(items: SessionListItem[]): string {
  const lines = ['📋 会话列表', ''];
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const d = new Date(s.mtime);
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const current = s.isCurrent ? '\n   ▶ 当前会话' : '';
    lines.push(`${i + 1}. ${date} | ${s.messageCount}条 | ${s.preview}${current}`);
  }
  lines.push('', '使用 /resume <序号> 恢复会话');
  return lines.join('\n');
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm test -- tests/unit/shared/history.test.ts`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add src/shared/history.ts tests/unit/shared/history.test.ts
git commit -m "feat: 添加 getSessionList 和 formatSessionList"
```

---

## Chunk 3: /resume 命令 — SessionManager + Handler

### Task 5: SessionManager.resumeSession

**Files:**
- Modify: `src/session/session-manager.ts:158-174`（在 `newSession` 后添加）
- Test: `tests/unit/session/session-manager.test.ts`

- [ ] **Step 1: 写失败测试**

在 session-manager.test.ts 中添加 describe：

```typescript
describe('resumeSession', () => {
  it('转存旧 convId 的 sessionId', () => {
    manager.getConvId('user1'); // 初始化
    manager.setSessionId('user1', 'old-session-id');
    const oldConvId = manager.getConvId('user1');

    manager.resumeSession('user1', 'target-session-id');

    // 旧 convId 的 sessionId 应该被保留在 convSessionMap
    expect(manager.getSessionIdForConv('user1', oldConvId)).toBe('old-session-id');
  });

  it('设置目标 sessionId', () => {
    manager.getConvId('user1');

    manager.resumeSession('user1', 'target-session-id');

    expect(manager.getSessionId('user1')).toBe('target-session-id');
  });

  it('生成新 convId', () => {
    manager.getConvId('user1');
    const oldConvId = manager.getConvId('user1');

    manager.resumeSession('user1', 'target-session-id');

    expect(manager.getConvId('user1')).not.toBe(oldConvId);
  });

  it('重置 totalTurns', () => {
    manager.getConvId('user1');
    manager.addTurns('user1', 5);

    manager.resumeSession('user1', 'target-session-id');

    // totalTurns 重置后再加 0 应该是 0
    expect(manager.addTurns('user1', 0)).toBe(0);
  });

  it('用户不存在时返回 false', () => {
    const result = manager.resumeSession('nonexistent', 'any-session-id');

    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- tests/unit/session/session-manager.test.ts`
Expected: FAIL — `resumeSession` 方法不存在

- [ ] **Step 3: 实现 resumeSession**

在 `src/session/session-manager.ts` 的 `newSession` 方法后添加：

```typescript
resumeSession(userId: string, sessionId: string): boolean {
  const session = this.sessions.get(userId);
  if (!session) return false;
  // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
  if (session.activeConvId && session.sessionId) {
    this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
    this.pruneConvSessionMap();
  }
  session.sessionId = sessionId;
  session.activeConvId = this.generateConvId();
  session.totalTurns = 0;
  this.flushSync();
  log.info(`Resumed session for user ${userId}: ${sessionId}`);
  return true;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- tests/unit/session/session-manager.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/session/session-manager.ts tests/unit/session/session-manager.test.ts
git commit -m "feat: SessionManager 添加 resumeSession 方法"
```

### Task 6: handleResume 命令处理

**Files:**
- Modify: `src/commands/handler.ts`（dispatch 注册 + handleResume 方法 + /help 文本）
- Modify: `src/shared/history.ts`（确保导出 getSessionList, formatSessionList）
- Test: `tests/unit/commands/handler.test.ts`

- [ ] **Step 1: 写失败测试**

在 handler.test.ts 中添加 describe：

```typescript
// ─── /resume ───

describe('handleResume', () => {
  it('should route /resume in dispatch', async () => {
    const result = await handler.dispatch('/resume', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(result).toBe(true);
  });

  it('should show session list when no args', async () => {
    const { getSessionList } = await import('../../../src/shared/history.js');
    vi.mocked(getSessionList).mockResolvedValue({
      ok: true,
      data: [
        { sessionId: 'abc', mtime: Date.now(), messageCount: 5, preview: 'hello', isCurrent: true },
      ],
    });
    await handler.dispatch('/resume', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('会话列表'),
      undefined,
    );
  });

  it('should resume session by index', async () => {
    const { getSessionList } = await import('../../../src/shared/history.js');
    vi.mocked(getSessionList).mockResolvedValue({
      ok: true,
      data: [
        { sessionId: 'newest', mtime: 3000, messageCount: 5, preview: 'msg3', isCurrent: false },
        { sessionId: 'middle', mtime: 2000, messageCount: 3, preview: 'msg2', isCurrent: true },
        { sessionId: 'oldest', mtime: 1000, messageCount: 1, preview: 'msg1', isCurrent: false },
      ],
    });
    await handler.dispatch('/resume 1', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sessionManager.resumeSession).toHaveBeenCalledWith(USER_ID, 'newest');
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('已恢复'),
      undefined,
    );
  });

  it('should reject out-of-range index', async () => {
    const { getSessionList } = await import('../../../src/shared/history.js');
    vi.mocked(getSessionList).mockResolvedValue({
      ok: true,
      data: [
        { sessionId: 'only', mtime: 1000, messageCount: 1, preview: 'msg', isCurrent: true },
      ],
    });
    await handler.dispatch('/resume 99', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('无效的序号'),
      undefined,
    );
  });

  it('should reject index 0', async () => {
    const { getSessionList } = await import('../../../src/shared/history.js');
    vi.mocked(getSessionList).mockResolvedValue({
      ok: true,
      data: [
        { sessionId: 'only', mtime: 1000, messageCount: 1, preview: 'msg', isCurrent: true },
      ],
    });
    await handler.dispatch('/resume 0', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('无效的序号'),
      undefined,
    );
  });

  it('should warn when resuming current session', async () => {
    const { getSessionList } = await import('../../../src/shared/history.js');
    vi.mocked(getSessionList).mockResolvedValue({
      ok: true,
      data: [
        { sessionId: 'current-sess', mtime: 1000, messageCount: 5, preview: 'msg', isCurrent: true },
      ],
    });
    await handler.dispatch('/resume 1', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
    expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
      CHAT_ID,
      expect.stringContaining('当前会话'),
      undefined,
    );
    expect(deps.sessionManager.resumeSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- tests/unit/commands/handler.test.ts`
Expected: FAIL — `/resume` 未注册

- [ ] **Step 3: 在 handler.ts 中添加 mock 前提**

确保 handler.test.ts 顶部的 mock 和 import 包含 `getSessionList` 和 `formatSessionList`：

```typescript
// 在已有的 history.js mock 附近添加
import { getHistory, formatHistoryPage, getSessionList, formatSessionList } from '../../../src/shared/history.js';
```

并在 deps.sessionManager mock 中添加 `resumeSession: vi.fn(() => true)`。

- [ ] **Step 4: 实现 handleResume**

在 `src/commands/handler.ts` 中：

1. 在 import 中添加 `getSessionList, formatSessionList`
2. 在 dispatch 中注册（在 `/history` 之后）：
```typescript
if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
  return this.handleResume(chatId, userId, trimmed.slice(7).trim(), threadCtx);
}
```

3. 添加 handleResume 方法：
```typescript
async handleResume(chatId: string, userId: string, args: string, threadCtx?: ThreadContext): Promise<boolean> {
  const workDir = threadCtx
    ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
    : this.deps.sessionManager.getWorkDir(userId);
  const currentSessionId = threadCtx
    ? this.deps.sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
    : this.deps.sessionManager.getSessionIdForConv(userId, this.deps.sessionManager.getConvId(userId));

  const listResult = await getSessionList(workDir, currentSessionId);
  if (!listResult.ok) {
    await this.deps.sender.sendTextReply(chatId, listResult.error, threadCtx);
    return true;
  }

  if (!args) {
    await this.deps.sender.sendTextReply(chatId, formatSessionList(listResult.data), threadCtx);
    return true;
  }

  const index = parseInt(args, 10) - 1;
  if (isNaN(index) || index < 0 || index >= listResult.data.length) {
    await this.deps.sender.sendTextReply(chatId, `无效的序号 ${args}，共 ${listResult.data.length} 个会话。`, threadCtx);
    return true;
  }

  const target = listResult.data[index];
  if (target.isCurrent) {
    await this.deps.sender.sendTextReply(chatId, '该会话已是当前会话。', threadCtx);
    return true;
  }

  this.deps.sessionManager.resumeSession(userId, target.sessionId);
  await this.deps.sender.sendTextReply(chatId, `已恢复会话: ${target.preview}\n后续消息将延续该会话上下文。`, threadCtx);
  return true;
}
```

4. 更新 `/help` 文本：
```typescript
// 修改现有行：
'/history [页码]  - 查看当前会话聊天记录',
// 在其后添加：
'/resume [序号]   - 浏览/恢复历史会话',
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test -- tests/unit/commands/handler.test.ts`
Expected: PASS

- [ ] **Step 6: 运行全部测试**

Run: `pnpm test`
Expected: 全部 PASS

- [ ] **Step 7: 构建检查**

Run: `pnpm build`
Expected: 无编译错误

- [ ] **Step 8: 提交**

```bash
git add src/commands/handler.ts tests/unit/commands/handler.test.ts
git commit -m "feat: 添加 /resume 命令，支持会话列表浏览与恢复"
```

---

## Chunk 4: 文档更新

### Task 7: 更新文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 更新 CLAUDE.md**

在命令系统部分（约第 127 行附近），更新 `/history` 描述并添加 `/resume`：

```markdown
- 会话管理：`/new`、`/compact`、`/resume`
- 状态查询：`/status`、`/cost`、`/doctor`、`/history`
```

- [ ] **Step 2: 更新 CHANGELOG.md**

在 `## [Unreleased]` 部分添加：

```markdown
### 新功能

- `/resume` 命令：浏览当前工作区的历史会话列表，支持按序号恢复任意历史会话
- `/history` 优化：默认显示最新消息，消息完整展示不截断，添加时间戳显示
```

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: 更新 CLAUDE.md 和 CHANGELOG.md 记录 /history 优化和 /resume 命令"
```
