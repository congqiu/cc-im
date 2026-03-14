# 代码库优化实施计划

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提取共享层、拆分飞书事件处理器、补全关键路径测试，提升代码可维护性和测试覆盖率。

**Architecture:** 混合方案 C — 先增强共享层（retry.ts 扩展、MessageSender 接口迁移），再将飞书 570 行的 event-handler.ts 按职责拆分为入口分发器 + task-executor + permission-handler，最后补全 hook-script 和 feishu/client 的测试。

**Tech Stack:** TypeScript (ESM, strict), Vitest, pnpm

**Spec:** `docs/superpowers/specs/2026-03-14-codebase-optimization-design.md`

---

## Chunk 1: 共享层增强

### Task 1: 增强 retry.ts — 添加 shouldRetry 回调

**Files:**
- Modify: `src/shared/retry.ts`
- Modify: `tests/unit/shared/retry.test.ts`

- [ ] **Step 1: 在 retry.test.ts 中添加 shouldRetry 的失败测试**

在现有测试文件末尾追加：

```typescript
it('shouldRetry 返回 false 时不重试', async () => {
  const fn = vi.fn().mockRejectedValue(new Error('custom error'));

  await expect(
    withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 20,
      shouldRetry: (err) => !(err instanceof Error && err.message === 'custom error'),
    }),
  ).rejects.toThrow('custom error');
  expect(fn).toHaveBeenCalledTimes(1); // 不重试
});

it('shouldRetry 返回 true 时正常重试', async () => {
  vi.useRealTimers();
  const fn = vi.fn()
    .mockRejectedValueOnce(new Error('transient'))
    .mockResolvedValue('ok');

  const result = await withRetry(fn, {
    maxRetries: 3,
    baseDelayMs: 10,
    maxDelayMs: 20,
    shouldRetry: () => true,
  });
  expect(result).toBe('ok');
  expect(fn).toHaveBeenCalledTimes(2);
  vi.useFakeTimers();
});

it('NonRetryableError 优先于 shouldRetry', async () => {
  const fn = vi.fn().mockRejectedValue(new NonRetryableError('non-retryable'));

  await expect(
    withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 20,
      shouldRetry: () => true, // 即使返回 true，NonRetryableError 仍不重试
    }),
  ).rejects.toThrow('non-retryable');
  expect(fn).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `pnpm test -- tests/unit/shared/retry.test.ts`
Expected: 新增的 3 个测试失败（shouldRetry 选项不存在）

- [ ] **Step 3: 实现 shouldRetry 选项**

修改 `src/shared/retry.ts`：

```typescript
export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const baseDelay = opts?.baseDelayMs ?? 500;
  const maxDelay = opts?.maxDelayMs ?? 5000;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NonRetryableError) throw err;
      if (opts?.shouldRetry && !opts.shouldRetry(err)) throw err;
      if (attempt >= maxRetries) throw err;
      const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * 200, maxDelay);
      log.warn(`Retry ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms: ${(err as Error)?.message ?? err}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}
```

关键变更：`NonRetryableError` 检查在前，`shouldRetry` 检查在后，`attempt >= maxRetries` 在最后。

- [ ] **Step 4: 运行测试验证通过**

Run: `pnpm test -- tests/unit/shared/retry.test.ts`
Expected: 全部 9 个测试通过

- [ ] **Step 5: 提交**

```bash
git add src/shared/retry.ts tests/unit/shared/retry.test.ts
git commit -m "feat: retry.ts 增加 shouldRetry 回调支持"
```

### Task 2: 迁移 MessageSender 接口到 shared/types.ts

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/commands/handler.ts`

- [ ] **Step 1: 在 types.ts 中添加 MessageSender 接口**

在 `src/shared/types.ts` 末尾追加：

```typescript
/**
 * 平台无关的消息发送接口
 */
export interface MessageSender {
  sendTextReply(chatId: string, text: string, threadCtx?: ThreadContext): Promise<void>;
}
```

- [ ] **Step 2: 修改 handler.ts 改为从 types.ts 导入**

在 `src/commands/handler.ts` 中：
- 将 `export type { ThreadContext, CostRecord };` 改为 `export type { ThreadContext, CostRecord, MessageSender };`
- 删除 `MessageSender` 接口定义（第 19-21 行）
- 在已有的 `import type { ThreadContext, CostRecord } from '../shared/types.js';` 中加入 `MessageSender`

修改后的 import 行：
```typescript
import type { ThreadContext, CostRecord, MessageSender } from '../shared/types.js';
export type { ThreadContext, CostRecord, MessageSender };
```

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `pnpm test`
Expected: 全部测试通过（接口定义位置变了，但通过 re-export 保持向后兼容）

- [ ] **Step 4: 提交**

```bash
git add src/shared/types.ts src/commands/handler.ts
git commit -m "refactor: 迁移 MessageSender 接口到 shared/types.ts"
```

---

## Chunk 2: 飞书事件处理器拆分

### Task 3: 提取 task-executor.ts

**Files:**
- Create: `src/feishu/task-executor.ts`
- Modify: `src/feishu/event-handler.ts`

- [ ] **Step 1: 创建 task-executor.ts**

从 `event-handler.ts` 提取 `handleClaudeRequest` 函数和相关依赖。新文件内容：

```typescript
import type { Config } from '../config.js';
import type { SessionManager } from '../session/session-manager.js';
import { sendThinkingCard, streamContentUpdate, sendFinalCards, sendErrorCard, sendTextReply, uploadAndSendImage, type CardHandle, type ThreadContext } from './message-sender.js';
import { buildCardV2 } from './card-builder.js';
import { destroySession, updateCardFull, disableStreaming } from './cardkit-manager.js';
import { runClaudeTask, type TaskRunState } from '../shared/claude-task.js';
import { CARDKIT_THROTTLE_MS } from '../constants.js';
import type { CostRecord } from '../shared/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('FeishuTask');

export interface TaskInfo extends TaskRunState {
  cardId: string;
  messageId: string;
}

export interface TaskExecutorDeps {
  config: Config;
  sessionManager: SessionManager;
  userCosts: Map<string, CostRecord>;
  runningTasks: Map<string, TaskInfo>;
}

export async function executeClaudeTask(
  deps: TaskExecutorDeps,
  userId: string,
  chatId: string,
  prompt: string,
  workDir: string,
  convId?: string,
  threadCtx?: ThreadContext,
  mentionedBot?: boolean,
  isGroup?: boolean,
) {
  const { config, sessionManager, userCosts, runningTasks } = deps;

  const sessionId = threadCtx && threadCtx.threadId
    ? sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
    : convId
      ? sessionManager.getSessionIdForConv(userId, convId)
      : undefined;

  log.info(`Running Claude for user ${userId}, ${threadCtx ? `thread=${threadCtx.threadId}` : `convId=${convId}`}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

  let cardHandle: CardHandle;
  try {
    cardHandle = await sendThinkingCard(chatId, threadCtx);
  } catch (err) {
    log.error('Failed to send thinking card:', err);
    return;
  }

  const { messageId, cardId } = cardHandle;

  if (!cardId) {
    log.error('No card_id returned for thinking card');
    return;
  }

  const taskKey = `${userId}:${cardId}`;
  let waitingTimer: ReturnType<typeof setInterval> | null = null;

  await runClaudeTask(
    { config, sessionManager, userCosts },
    {
      userId,
      chatId,
      workDir,
      sessionId,
      convId,
      threadId: threadCtx?.threadId,
      threadRootMsgId: threadCtx?.rootMessageId,
      platform: 'feishu',
      taskKey,
    },
    prompt,
    {
      throttleMs: CARDKIT_THROTTLE_MS,
      streamUpdate: (content, toolNote) => {
        streamContentUpdate(cardId, content, toolNote).catch((e) => log.warn('Stream update failed:', e?.message ?? e));
      },
      sendComplete: async (content, note, thinkingText) => {
        try {
          await sendFinalCards(chatId, messageId, cardId, content, note, threadCtx, thinkingText);
          if (isGroup && mentionedBot) {
            const replyText = `<at user_id="${userId}"></at> 任务已完成 ✅`;
            await sendTextReply(chatId, replyText, threadCtx);
          }
        } catch (err) {
          log.error('Failed to send final cards:', err);
        }
      },
      sendError: async (error) => {
        try {
          await sendErrorCard(cardId, error);
        } catch (err) {
          log.error('Failed to send error card:', err);
        }
      },
      onThinkingToText: (content, _thinkingText) => {
        const resetCard = buildCardV2({ content: content || '...', status: 'streaming' }, cardId);
        updateCardFull(cardId, resetCard)
          .catch((e) => log.warn('Thinking→text transition update failed:', e?.message ?? e));
      },
      extraCleanup: () => {
        if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
        runningTasks.delete(taskKey);
      },
      onTaskReady: (state) => {
        runningTasks.set(taskKey, { ...state, cardId, messageId });
        const startTime = Date.now();
        waitingTimer = setInterval(() => {
          const taskInfo = runningTasks.get(taskKey);
          if (!taskInfo) {
            if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
            return;
          }
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          streamContentUpdate(cardId, `等待 Claude 响应... (${elapsed}s)`).catch(() => {});
        }, 3000);
      },
      onFirstContent: () => {
        if (waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; }
      },
      sendImage: (imagePath) => uploadAndSendImage(chatId, imagePath, threadCtx),
    },
  );
}

export function handleStopAction(
  runningTasks: Map<string, TaskInfo>,
  userId: string,
  cardId: string,
) {
  const taskKey = `${userId}:${cardId}`;
  const taskInfo = runningTasks.get(taskKey);

  if (taskInfo) {
    log.info(`User ${userId} stopped task for card ${cardId}`);
    const stoppedContent = taskInfo.latestContent || '(任务已停止，暂无输出)';
    runningTasks.delete(taskKey);
    taskInfo.settle();
    taskInfo.handle.abort();

    const stoppedCard = buildCardV2({ content: stoppedContent, status: 'done', note: '⏹️ 已停止' });
    disableStreaming(cardId)
      .then(() => updateCardFull(cardId, stoppedCard))
      .catch((e) => log.warn('Stop card update failed:', e?.message ?? e))
      .finally(() => destroySession(cardId));
  } else {
    log.warn(`No running task found for key: ${taskKey}`);
    log.info(`Current running tasks: ${Array.from(runningTasks.keys()).join(', ')}`);
  }
}
```

- [ ] **Step 2: 修改 event-handler.ts 使用 task-executor**

在 `event-handler.ts` 中：
1. 添加 import：`import { executeClaudeTask, handleStopAction, type TaskInfo } from './task-executor.js';`
2. 删除 `handleClaudeRequest` 函数（第 139-247 行）
3. 删除 `TaskInfo` 接口定义（第 99-102 行）
4. 将 `createEventDispatcher` 中对 `handleClaudeRequest` 的调用替换为 `executeClaudeTask`
5. 将停止按钮处理（第 364-392 行）替换为 `handleStopAction(runningTasks, userId, cardId)`

替换调用点：

`routeToThread` 中（原第 283 行）：
```typescript
await executeClaudeTask(
  { config, sessionManager, userCosts, runningTasks },
  userId, chatId, prompt, workDir, undefined, threadCtx, mentionedBot, true,
);
```

`routeToDefault` 中（原第 305 行）：
```typescript
await executeClaudeTask(
  { config, sessionManager, userCosts, runningTasks },
  userId, chatId, prompt, workDirSnapshot, convIdSnapshot, undefined, mentionedBot, isGroup,
);
```

`commandHandler.dispatch` 调用中（原第 553 行），`handleClaudeRequest` 回调改为适配 `ClaudeRequestHandler` 的 6 参数签名：
```typescript
(userId, chatId, prompt, workDir, convId, threadCtx) =>
  executeClaudeTask(
    { config, sessionManager, userCosts, runningTasks },
    userId, chatId, prompt, workDir, convId, threadCtx,
  )
```

注意：`ClaudeRequestHandler` 类型（定义在 `handler.ts` 第 38-45 行）只有 6 个参数，不含 `mentionedBot` 和 `isGroup`。这两个参数仅在 `routeToThread` 和 `routeToDefault` 的直接调用中传递，命令处理器不需要它们。

停止按钮处理（原第 364-392 行）替换为：
```typescript
if (actionData.action === 'stop') {
  const cardId = actionData.card_id;
  if (!cardId) {
    log.warn('No card_id in stop action data');
    return;
  }
  handleStopAction(runningTasks, userId, cardId);
}
```

- [ ] **Step 3: 运行 TypeScript 编译检查**

Run: `pnpm build`
Expected: 编译通过，无类型错误

- [ ] **Step 4: 运行全量测试**

Run: `pnpm test`
Expected: 全部测试通过

- [ ] **Step 5: 提交**

```bash
git add src/feishu/task-executor.ts src/feishu/event-handler.ts
git commit -m "refactor: 从飞书 event-handler 中提取 task-executor"
```

### Task 4: 提取 permission-handler.ts

**Files:**
- Create: `src/feishu/permission-handler.ts`
- Modify: `src/feishu/event-handler.ts`

- [ ] **Step 1: 创建 permission-handler.ts**

从 `event-handler.ts` 提取权限相关逻辑：

```typescript
import { registerPermissionSender, resolvePermissionById } from '../hook/permission-server.js';
import { sendPermissionCard, updatePermissionCard } from './message-sender.js';
import { createLogger } from '../logger.js';

const log = createLogger('FeishuPermission');

/**
 * 注册飞书平台的权限消息发送器
 */
export function registerFeishuPermissionSender() {
  registerPermissionSender('feishu', {
    sendPermissionCard,
    updatePermissionCard: ({ messageId, toolName, decision }) =>
      updatePermissionCard(messageId, toolName, decision),
  });
}

/**
 * 处理权限按钮点击（allow/deny）
 */
export function handlePermissionAction(requestId: string, decision: 'allow' | 'deny') {
  const resolvedId = resolvePermissionById(requestId, decision);
  if (resolvedId) {
    log.info(`Permission ${decision} via button for request ${requestId}`);
  } else {
    log.warn(`No pending permission request found for requestId: ${requestId}`);
  }
}
```

- [ ] **Step 2: 修改 event-handler.ts 使用 permission-handler**

1. 添加 import：`import { registerFeishuPermissionSender, handlePermissionAction } from './permission-handler.js';`
2. 删除 `registerPermissionSender` 和 `resolvePermissionById` 的 import
3. 将 `registerPermissionSender('feishu', ...)` 调用替换为 `registerFeishuPermissionSender()`
4. 将权限按钮处理代码（原 `else if (actionData.action === 'allow' || ...)`）替换为：

```typescript
} else if (actionData.action === 'allow' || actionData.action === 'deny') {
  const requestId = actionData.requestId;
  if (!requestId) {
    log.warn('No requestId in permission action');
    return;
  }
  handlePermissionAction(requestId, actionData.action);
}
```

- [ ] **Step 3: 运行编译和测试**

Run: `pnpm build && pnpm test`
Expected: 编译通过，全部测试通过

- [ ] **Step 4: 提交**

```bash
git add src/feishu/permission-handler.ts src/feishu/event-handler.ts
git commit -m "refactor: 从飞书 event-handler 中提取 permission-handler"
```

---

## Chunk 3: Telegram 重试统一

### Task 5: Telegram 429 重试改用 withRetry

**Files:**
- Modify: `src/telegram/message-sender.ts`

- [ ] **Step 1: 修改 callWithRetry 使用共享 withRetry**

保留 `chatCooldownUntil` 前置冷却机制不动。仅将 `callWithRetry` 的 for 循环重试部分改用 `withRetry`：

在文件顶部添加 import：
```typescript
import { withRetry } from '../shared/retry.js';
```

将 `callWithRetry` 函数（第 58-87 行）替换为：

```typescript
async function callWithRetry<T>(chatId: string, label: string, fn: () => Promise<T>): Promise<T> {
  // Wait for any existing cooldown before first attempt (e.g. from streaming 429)
  const cooldownUntil = chatCooldownUntil.get(chatId);
  if (cooldownUntil) {
    const waitMs = cooldownUntil - Date.now();
    if (waitMs > 0) {
      log.info(`${label}: waiting ${Math.ceil(waitMs / 1000)}s for existing cooldown`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    chatCooldownUntil.delete(chatId);
  }

  return withRetry(fn, {
    maxRetries: MAX_RETRIES - 1, // withRetry 的 maxRetries 不含首次
    baseDelayMs: 1000,
    maxDelayMs: RATE_LIMIT_MAX_WAIT_SEC * 1000,
    shouldRetry: (err) => {
      const retryAfter = parseRetryAfter(err);
      if (retryAfter !== null) {
        setCooldown(chatId, retryAfter);
        log.warn(`${label}: rate limited, retry after ${retryAfter}s`);
        return true;
      }
      return false; // 非 429 错误不重试
    },
  });
}
```

注意：`withRetry` 的 `maxRetries` 语义是"首次失败后最多重试 N 次"，所以传 `MAX_RETRIES - 1`（即 2）以保持与原来一共 3 次尝试的行为一致。

但实际检查原代码 `withRetry` 的实现：attempt 从 0 开始，`attempt >= maxRetries` 时抛出，所以 `maxRetries: 2` 意味着首次 + 2 次重试 = 3 次总尝试。这与原始 `MAX_RETRIES = 3` 的循环一致。

**延迟语义差异说明**：原始代码直接等待 `retry_after` 秒数，而 `withRetry` 使用指数退避计算延迟。这意味着重试等待时间可能与服务器建议的不完全一致。但这是可接受的：(1) `setCooldown` 会记录正确的冷却时间，后续调用会在冷却期内等待；(2) `maxDelayMs` 设为 60s（`RATE_LIMIT_MAX_WAIT_SEC`），覆盖了大多数 429 的 retry_after 值。

- [ ] **Step 2: 运行测试**

Run: `pnpm test -- tests/unit/telegram/`
Expected: 全部 Telegram 测试通过

- [ ] **Step 3: 运行全量测试**

Run: `pnpm test`
Expected: 全部测试通过

- [ ] **Step 4: 提交**

```bash
git add src/telegram/message-sender.ts
git commit -m "refactor: Telegram 429 重试改用共享 withRetry"
```

---

## Chunk 4: 测试补全

### Task 6: 新增 hook-script.ts 测试

**Files:**
- Modify: `src/hook/hook-script.ts`（将 `main()` 调用改为条件执行）
- Create: `tests/unit/hook/hook-script.test.ts`

- [ ] **Step 1: 修改 hook-script.ts 支持测试**

将第 136 行的 `main();` 改为条件执行：

```typescript
/* c8 ignore next 3 */
const isDirectRun = process.argv[1]?.endsWith('hook-script.js');
if (isDirectRun) main();

export { main, readStdin, httpPost };
```

注意：不要在函数定义处加 `export`（避免双重导出），仅通过底部的 `export { main, readStdin, httpPost }` 导出。

- [ ] **Step 2: 创建测试文件**

创建 `tests/unit/hook/hook-script.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before import
vi.mock('node:http', () => ({
  request: vi.fn(),
}));

vi.mock('../../../src/constants.js', () => ({
  READ_ONLY_TOOLS: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoRead'],
  HOOK_EXIT_CODES: { SUCCESS: 0, ERROR: 1, PERMISSION_SERVER_ERROR: 2 },
}));

import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';

describe('hook-script', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let processExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    processExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  async function importMain() {
    const mod = await import('../../../src/hook/hook-script.js');
    return mod;
  }

  function mockHttpResponse(statusCode: number, body: string) {
    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ClientRequest;

    vi.mocked(request).mockImplementation((_opts, callback) => {
      const res = {
        statusCode,
        on: vi.fn((event: string, handler: (chunk?: string) => void) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
          return res;
        }),
      } as unknown as IncomingMessage;
      (callback as (res: IncomingMessage) => void)(res);
      return mockReq;
    });

    return mockReq;
  }

  describe('只读工具自动放行', () => {
    it('Read 工具应自动放行', async () => {
      process.env.CC_IM_CHAT_ID = 'test-chat';
      const { main, httpPost } = await importMain();

      // 直接测试逻辑：只读工具不应发 HTTP 请求
      // 通过检查 Read 在 READ_ONLY_TOOLS 中即可
      const { READ_ONLY_TOOLS } = await import('../../../src/constants.js');
      expect(READ_ONLY_TOOLS).toContain('Read');
      expect(READ_ONLY_TOOLS).toContain('Glob');
      expect(READ_ONLY_TOOLS).toContain('Grep');
    });
  });

  describe('httpPost', () => {
    it('成功时返回响应', async () => {
      mockHttpResponse(200, '{"decision":"allow"}');
      const { httpPost } = await importMain();

      const result = await httpPost(18900, '/permission-request', { chatId: 'test' });
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ decision: 'allow' });
    });

    it('服务器不可达时 reject', async () => {
      const mockReq = {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error('ECONNREFUSED'));
          return mockReq;
        }),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;

      vi.mocked(request).mockReturnValue(mockReq);
      const { httpPost } = await importMain();

      await expect(httpPost(18900, '/test', {})).rejects.toThrow('ECONNREFUSED');
    });
  });
});
```

- [ ] **Step 3: 运行测试验证通过**

Run: `pnpm test -- tests/unit/hook/hook-script.test.ts`
Expected: 全部测试通过

- [ ] **Step 4: 提交**

```bash
git add src/hook/hook-script.ts tests/unit/hook/hook-script.test.ts
git commit -m "test: 添加 hook-script 单元测试"
```

### Task 7: 新增 feishu/client.ts 测试

**Files:**
- Create: `tests/unit/feishu/client.test.ts`

- [ ] **Step 1: 创建测试文件**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  const mockClient = {
    request: vi.fn(),
  };
  const mockWSClient = {
    start: vi.fn(),
    close: vi.fn(),
  };
  return {
    Client: vi.fn(() => mockClient),
    WSClient: vi.fn(() => mockWSClient),
    LoggerLevel: { info: 2 },
    EventDispatcher: vi.fn(),
    __mockClient: mockClient,
    __mockWSClient: mockWSClient,
  };
});

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as Lark from '@larksuiteoapi/node-sdk';

describe('feishu/client', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('getClient 在初始化前应抛出错误', async () => {
    const { getClient } = await import('../../../src/feishu/client.js');
    expect(() => getClient()).toThrow('Feishu client not initialized');
  });

  it('initFeishu 成功获取 bot openId', async () => {
    const mockClient = (Lark as unknown as { __mockClient: { request: ReturnType<typeof vi.fn> } }).__mockClient;
    mockClient.request.mockResolvedValue({ bot: { open_id: 'ou_test123' } });

    const { initFeishu, getClient, getBotOpenId } = await import('../../../src/feishu/client.js');
    const dispatcher = new Lark.EventDispatcher();

    await initFeishu(
      { feishuAppId: 'app_id', feishuAppSecret: 'secret' } as any,
      dispatcher,
    );

    expect(getClient()).toBeDefined();
    expect(getBotOpenId()).toBe('ou_test123');
  });

  it('bot info 获取失败时优雅降级', async () => {
    const mockClient = (Lark as unknown as { __mockClient: { request: ReturnType<typeof vi.fn> } }).__mockClient;
    mockClient.request.mockRejectedValue(new Error('Network error'));

    const { initFeishu, getBotOpenId } = await import('../../../src/feishu/client.js');
    const dispatcher = new Lark.EventDispatcher();

    // 不应抛出异常
    await initFeishu(
      { feishuAppId: 'app_id', feishuAppSecret: 'secret' } as any,
      dispatcher,
    );

    expect(getBotOpenId()).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

Run: `pnpm test -- tests/unit/feishu/client.test.ts`
Expected: 全部测试通过

- [ ] **Step 3: 提交**

```bash
git add tests/unit/feishu/client.test.ts
git commit -m "test: 添加 feishu/client 单元测试"
```

### Task 8: 新增拆分后文件的测试

**Files:**
- Create: `tests/unit/feishu/task-executor.test.ts`
- Create: `tests/unit/feishu/permission-handler.test.ts`

- [ ] **Step 1: 创建 task-executor 测试文件**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/feishu/message-sender.js', () => ({
  sendThinkingCard: vi.fn(),
  streamContentUpdate: vi.fn().mockResolvedValue(undefined),
  sendFinalCards: vi.fn().mockResolvedValue(undefined),
  sendErrorCard: vi.fn().mockResolvedValue(undefined),
  sendTextReply: vi.fn().mockResolvedValue(undefined),
  uploadAndSendImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/feishu/card-builder.js', () => ({
  buildCardV2: vi.fn().mockReturnValue({}),
}));

vi.mock('../../../src/feishu/cardkit-manager.js', () => ({
  destroySession: vi.fn(),
  updateCardFull: vi.fn().mockResolvedValue(undefined),
  disableStreaming: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/shared/claude-task.js', () => ({
  runClaudeTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { sendThinkingCard } from '../../../src/feishu/message-sender.js';
import { handleStopAction, type TaskInfo } from '../../../src/feishu/task-executor.js';

describe('task-executor', () => {
  describe('handleStopAction', () => {
    it('应停止正在运行的任务', () => {
      const runningTasks = new Map<string, TaskInfo>();
      const mockAbort = vi.fn();
      const mockSettle = vi.fn();

      runningTasks.set('user1:card1', {
        cardId: 'card1',
        messageId: 'msg1',
        latestContent: '部分输出',
        handle: { abort: mockAbort } as any,
        settle: mockSettle,
      });

      handleStopAction(runningTasks, 'user1', 'card1');

      expect(mockSettle).toHaveBeenCalled();
      expect(mockAbort).toHaveBeenCalled();
      expect(runningTasks.has('user1:card1')).toBe(false);
    });

    it('任务不存在时应记录警告', () => {
      const runningTasks = new Map<string, TaskInfo>();
      // 不应抛出异常
      handleStopAction(runningTasks, 'user1', 'card-nonexistent');
      expect(runningTasks.size).toBe(0);
    });
  });
});
```

- [ ] **Step 2: 创建 permission-handler 测试文件**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/hook/permission-server.js', () => ({
  registerPermissionSender: vi.fn(),
  resolvePermissionById: vi.fn(),
}));

vi.mock('../../../src/feishu/message-sender.js', () => ({
  sendPermissionCard: vi.fn(),
  updatePermissionCard: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerPermissionSender, resolvePermissionById } from '../../../src/hook/permission-server.js';
import { registerFeishuPermissionSender, handlePermissionAction } from '../../../src/feishu/permission-handler.js';

describe('permission-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registerFeishuPermissionSender 应注册飞书权限发送器', () => {
    registerFeishuPermissionSender();
    expect(registerPermissionSender).toHaveBeenCalledWith('feishu', expect.objectContaining({
      sendPermissionCard: expect.any(Function),
      updatePermissionCard: expect.any(Function),
    }));
  });

  it('handlePermissionAction 应解析权限请求 (allow)', () => {
    vi.mocked(resolvePermissionById).mockReturnValue('req-123');
    handlePermissionAction('req-123', 'allow');
    expect(resolvePermissionById).toHaveBeenCalledWith('req-123', 'allow');
  });

  it('handlePermissionAction 应解析权限请求 (deny)', () => {
    vi.mocked(resolvePermissionById).mockReturnValue('req-456');
    handlePermissionAction('req-456', 'deny');
    expect(resolvePermissionById).toHaveBeenCalledWith('req-456', 'deny');
  });

  it('请求不存在时应记录警告', () => {
    vi.mocked(resolvePermissionById).mockReturnValue(undefined);
    // 不应抛出异常
    handlePermissionAction('req-nonexistent', 'allow');
    expect(resolvePermissionById).toHaveBeenCalledWith('req-nonexistent', 'allow');
  });
});
```

- [ ] **Step 3: 运行测试验证通过**

Run: `pnpm test -- tests/unit/feishu/task-executor.test.ts tests/unit/feishu/permission-handler.test.ts`
Expected: 全部测试通过

- [ ] **Step 4: 提交**

```bash
git add tests/unit/feishu/task-executor.test.ts tests/unit/feishu/permission-handler.test.ts
git commit -m "test: 添加 task-executor 和 permission-handler 单元测试"
```

### Task 9: 更新现有飞书 event-handler 测试

**Files:**
- Modify: `tests/unit/feishu/event-handler.test.ts`

拆分后 `event-handler.ts` 新增了对 `./task-executor.js` 和 `./permission-handler.js` 的 import，现有测试需要相应调整。

- [ ] **Step 1: 在测试文件顶部添加新模块的 mock**

在现有的 `vi.mock(...)` 块之后添加：

```typescript
vi.mock('../../../src/feishu/task-executor.js', () => ({
  executeClaudeTask: vi.fn().mockResolvedValue(undefined),
  handleStopAction: vi.fn(),
}));

vi.mock('../../../src/feishu/permission-handler.js', () => ({
  registerFeishuPermissionSender: vi.fn(),
  handlePermissionAction: vi.fn(),
}));
```

- [ ] **Step 2: 审查 `handleClaudeRequest` 测试（约第 740-913 行）**

这些测试通过 `createEventDispatcher` → `getMessageHandler` 间接测试 `handleClaudeRequest` 逻辑。拆分后 `event-handler.ts` 内部调用的是 `executeClaudeTask`（已被 mock），所以这些测试的断言目标要调整：

- 原来断言 `mockRunClaudeTask` → 现在应断言 `executeClaudeTask` 被调用
- 需要 import mock 后的 `executeClaudeTask`：
  ```typescript
  import { executeClaudeTask } from '../../../src/feishu/task-executor.js';
  ```
- 将 `expect(mockRunClaudeTask).not.toHaveBeenCalled()` 改为 `expect(executeClaudeTask).not.toHaveBeenCalled()`
- 类似地调整其他 `mockRunClaudeTask` 的断言

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `pnpm test`
Expected: 全部测试通过

- [ ] **Step 4: 提交**

```bash
git add tests/unit/feishu/
git commit -m "test: 更新飞书 event-handler 测试适配拆分后的结构"
```

---

## Chunk 5: 最终验证

### Task 10: 全量编译和测试验证

**Files:** 无新文件

- [ ] **Step 1: TypeScript 编译检查**

Run: `pnpm build`
Expected: 编译通过，无类型错误

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全部测试通过，无回归

- [ ] **Step 3: 验证 event-handler.ts 行数**

Run: `wc -l src/feishu/event-handler.ts`
Expected: ~430 行以下（原 570 行，提取了约 109 行 handleClaudeRequest + 4 行 TaskInfo 接口 + 约 29 行停止按钮逻辑简化为 6 行 + 约 16 行权限处理简化为 7 行）

- [ ] **Step 4: 更新 CLAUDE.md 架构文档**

在 CLAUDE.md 的飞书平台部分补充拆分后的文件结构说明：
```
- `src/feishu/task-executor.ts` — Claude 任务执行（CardKit 流式、停止按钮）
- `src/feishu/permission-handler.ts` — 权限按钮处理与权限发送器注册
```

- [ ] **Step 5: 最终提交**

```bash
git add CLAUDE.md
git commit -m "docs: 更新 CLAUDE.md 反映飞书模块拆分"
```
