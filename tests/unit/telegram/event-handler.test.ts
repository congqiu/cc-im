import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all dependencies at the top level BEFORE imports

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/access/access-control.js', () => ({
  AccessControl: vi.fn().mockImplementation(function (this: any, allowedUserIds: string[]) {
    this.isAllowed = vi.fn((userId: string) => allowedUserIds.length === 0 || allowedUserIds.includes(userId));
  }),
}));

vi.mock('../../../src/session/session-manager.js', () => ({
  SessionManager: vi.fn().mockImplementation(function (this: any) {
    this.getSessionId = vi.fn();
    this.setSessionId = vi.fn();
    this.getConvId = vi.fn(() => 'conv-123');
    this.getWorkDir = vi.fn(() => '/work');
    this.setWorkDir = vi.fn();
    this.clearSession = vi.fn(() => true);
    this.getSessionIdForConv = vi.fn(() => 'session-abc');
    this.setSessionIdForConv = vi.fn();
    this.getModel = vi.fn();
  }),
}));

vi.mock('../../../src/queue/request-queue.js', () => ({
  RequestQueue: vi.fn().mockImplementation(function (this: any) {
    this.enqueue = vi.fn((_userId: string, _convId: string, prompt: string, execute: (p: string) => void) => {
      execute(prompt);
      return 'running';
    });
  }),
}));

vi.mock('../../../src/telegram/message-sender.js', () => ({
  sendThinkingMessage: vi.fn().mockResolvedValue('msg-think-123'),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  sendFinalMessages: vi.fn().mockResolvedValue(undefined),
  sendTextReply: vi.fn().mockResolvedValue(undefined),
  sendPermissionMessage: vi.fn().mockResolvedValue('perm-msg-123'),
  updatePermissionMessage: vi.fn().mockResolvedValue(undefined),
  startTypingLoop: vi.fn(() => vi.fn()),
}));

vi.mock('../../../src/hook/permission-server.js', () => ({
  registerPermissionSender: vi.fn(),
  registerWatchSender: vi.fn(),
}));

vi.mock('../../../src/shared/active-chats.js', () => ({
  setActiveChatId: vi.fn(),
}));

vi.mock('../../../src/constants.js', () => ({
  APP_HOME: '/tmp/cc-im-test',
  TERMINAL_ONLY_COMMANDS: new Set([
    '/context', '/rewind', '/resume', '/copy', '/export',
    '/config', '/init', '/memory', '/permissions', '/theme',
    '/vim', '/statusline', '/terminal-setup', '/debug',
    '/tasks', '/mcp', '/teleport', '/add-dir',
  ]),
  DEDUP_TTL_MS: 5 * 60 * 1000,
  THROTTLE_MS: 200,
  IMAGE_DIR: '/tmp/cc-im-images',
}));

vi.mock('../../../src/claude/cli-runner.js', () => ({
  runClaude: vi.fn(() => ({
    process: { kill: vi.fn() },
    abort: vi.fn(),
  })),
}));

vi.mock('../../../src/shared/claude-task.js', () => ({
  runClaudeTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/shared/task-cleanup.js', () => ({
  startTaskCleanup: vi.fn(() => vi.fn()),
}));

vi.mock('../../../src/shared/message-dedup.js', () => ({
  MessageDedup: vi.fn().mockImplementation(function (this: any) {
    const seen = new Set<string>();
    this.isDuplicate = vi.fn((messageId: string) => {
      if (seen.has(messageId)) return true;
      seen.add(messageId);
      return false;
    });
  }),
}));

vi.mock('../../../src/commands/handler.js', () => ({
  CommandHandler: vi.fn().mockImplementation(function (this: any, deps: any) {
    this.deps = deps;
    this.dispatch = vi.fn(async (text: string, chatId: string, userId: string, platform: string, _handleClaudeRequest: any) => {
      const t = text.trim();
      if (platform === 'telegram' && t === '/start') {
        await deps.sender.sendTextReply(chatId, '欢迎使用 Claude Code Bot!');
        return true;
      }
      if (t === '/help') { await deps.sender.sendTextReply(chatId, '可用命令:\n...'); return true; }
      if (t === '/new') { await deps.sender.sendTextReply(chatId, '✅ 已开始新会话'); return true; }
      if (t === '/pwd') { await deps.sender.sendTextReply(chatId, '当前工作目录: /work'); return true; }
      const cmd = t.split(/\s+/)[0];
      const { TERMINAL_ONLY_COMMANDS } = await import('../../../src/constants.js');
      if (TERMINAL_ONLY_COMMANDS.has(cmd)) {
        await deps.sender.sendTextReply(chatId, `${cmd} 命令仅在终端交互模式下可用。\n\n输入 /help 查看可用命令。`);
        return true;
      }
      return false;
    });
  }),
}));

vi.mock('telegraf/filters', () => ({
  message: vi.fn((type: string) => type),
}));

vi.mock('../../../src/telegram/client.js', () => ({
  getBotUsername: vi.fn(() => 'test_bot'),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((path: string, args: string[], opts: any, cb: Function) => {
    cb(null, 'v1.0.0', '');
  }),
}));

// Import after all mocks
import { setupTelegramHandlers } from '../../../src/telegram/event-handler.js';
import * as messageSender from '../../../src/telegram/message-sender.js';
import { runClaudeTask } from '../../../src/shared/claude-task.js';
import { setActiveChatId } from '../../../src/shared/active-chats.js';

// Helper to create a mock bot and capture handlers
function createMockBot() {
  const handlers: Record<string, Function> = {};
  return {
    on: vi.fn((event: any, handler: Function) => {
      if (event === 'callback_query') {
        handlers['callback_query'] = handler;
      } else {
        // message('text') returns 'text', message('photo') returns 'photo'
        handlers[event] = handler;
      }
    }),
    telegram: {
      getFileLink: vi.fn(),
    },
    handlers,
  };
}

const mockConfig = {
  enabledPlatforms: ['telegram' as const],
  feishuAppId: '',
  feishuAppSecret: '',
  telegramBotToken: 'test-token',
  allowedUserIds: [] as string[],
  claudeCliPath: '/claude',
  claudeWorkDir: '/work',
  allowedBaseDirs: ['/work'],
  claudeSkipPermissions: false,
  claudeTimeoutMs: 300000,
  hookPort: 18900,
};

const mockSessionManager = {
  getSessionId: vi.fn(),
  setSessionId: vi.fn(),
  getConvId: vi.fn(() => 'conv-123'),
  getWorkDir: vi.fn(() => '/work'),
  setWorkDir: vi.fn(),
  clearSession: vi.fn(() => true),
  getSessionIdForConv: vi.fn(() => 'session-abc'),
  setSessionIdForConv: vi.fn(),
  getModel: vi.fn(),
};

describe('Telegram Event Handler', () => {
  let mockBot: ReturnType<typeof createMockBot>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBot = createMockBot();
  });

  // --- setup & lifecycle ---

  it('setupTelegramHandlers 应该注册 callback_query、text 和 photo 处理器', () => {
    setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);

    expect(mockBot.on).toHaveBeenCalledTimes(3);
    expect(mockBot.handlers['callback_query']).toBeDefined();
    expect(mockBot.handlers['text']).toBeDefined();
    expect(mockBot.handlers['photo']).toBeDefined();
  });

  it('getRunningTaskCount 初始应该返回 0', () => {
    const handle = setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
    expect(handle.getRunningTaskCount()).toBe(0);
  });

  // --- text message handlers ---

  describe('文本消息处理', () => {
    function createTextCtx(overrides: Record<string, any> = {}) {
      return {
        chat: { id: 123, type: 'private', ...overrides.chat },
        from: { id: 456, ...overrides.from },
        message: { message_id: Date.now(), text: 'Hello', ...overrides.message },
      };
    }

    it('群聊无 @mention 应该被忽略', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const ctx = createTextCtx({ chat: { id: 123, type: 'group' }, message: { message_id: Date.now(), text: 'Hello' } });
      await handler(ctx);

      expect(messageSender.sendTextReply).not.toHaveBeenCalled();
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('群聊 @机器人 应该响应', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const ctx = createTextCtx({
        chat: { id: 123, type: 'group' },
        message: {
          message_id: Date.now(),
          text: '@test_bot 帮我写代码',
          entities: [{ type: 'mention', offset: 0, length: 9 }],
        },
      });
      await handler(ctx);

      expect(messageSender.sendThinkingMessage).toHaveBeenCalledWith('123', expect.any(String));
      expect(runClaudeTask).toHaveBeenCalled();
    });

    it('重复消息应该被忽略', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const ctx = createTextCtx({ message: { message_id: 999, text: 'Hello' } });
      await handler(ctx);
      vi.mocked(messageSender.sendTextReply).mockClear();
      vi.mocked(runClaudeTask).mockClear();

      // 同一 messageId 再次发送
      await handler(ctx);

      // 第二次不应有任何处理
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('未授权用户应该被拒绝', async () => {
      const restrictedConfig = { ...mockConfig, allowedUserIds: ['allowed-user'] };
      setupTelegramHandlers(mockBot as any, restrictedConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const ctx = createTextCtx({ from: { id: 789 } });
      await handler(ctx);

      expect(messageSender.sendTextReply).toHaveBeenCalledWith(
        '123',
        expect.stringContaining('没有访问权限'),
      );
    });

    it('命令分发成功时应该直接返回', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const ctx = createTextCtx({ message: { message_id: 1001, text: '/help' } });
      await handler(ctx);

      expect(messageSender.sendTextReply).toHaveBeenCalledWith(
        '123',
        expect.stringContaining('可用命令'),
      );
      // 不应调用 runClaudeTask
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('普通消息应该入队并调用 runClaudeTask', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const ctx = createTextCtx({ message: { message_id: 2001, text: '帮我写代码' } });
      await handler(ctx);

      expect(messageSender.sendThinkingMessage).toHaveBeenCalledWith('123', undefined);
      expect(runClaudeTask).toHaveBeenCalled();
    });

    it('队列满时应该返回拒绝消息', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      // 让 RequestQueue.enqueue 返回 'rejected'
      const { RequestQueue } = await import('../../../src/queue/request-queue.js');
      const rqInstance = vi.mocked(RequestQueue).mock.results[0]?.value;
      if (rqInstance) {
        rqInstance.enqueue.mockReturnValueOnce('rejected');
      }

      const ctx = createTextCtx({ message: { message_id: 3001, text: '请求' } });
      await handler(ctx);

      expect(messageSender.sendTextReply).toHaveBeenCalledWith(
        '123',
        expect.stringContaining('队列已满'),
      );
    });

    it('队列排队时应该返回排队消息', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const { RequestQueue } = await import('../../../src/queue/request-queue.js');
      const rqInstance = vi.mocked(RequestQueue).mock.results[0]?.value;
      if (rqInstance) {
        rqInstance.enqueue.mockReturnValueOnce('queued');
      }

      const ctx = createTextCtx({ message: { message_id: 3002, text: '请求' } });
      await handler(ctx);

      expect(messageSender.sendTextReply).toHaveBeenCalledWith(
        '123',
        expect.stringContaining('排队等待'),
      );
    });

    it('应该设置活跃聊天 ID', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const ctx = createTextCtx({ message: { message_id: 4001, text: '测试' } });
      await handler(ctx);

      expect(setActiveChatId).toHaveBeenCalledWith('telegram', '123');
    });
  });

  // --- photo message handlers ---

  describe('图片消息处理', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function createPhotoCtx(overrides: Record<string, any> = {}) {
      return {
        chat: { id: 123, type: 'private', ...overrides.chat },
        from: { id: 456, ...overrides.from },
        message: {
          message_id: Date.now(),
          caption: undefined as string | undefined,
          photo: [
            { file_id: 'small-id', width: 100, height: 100 },
            { file_id: 'large-id', width: 800, height: 600 },
          ],
          ...overrides.message,
        },
      };
    }

    it('群聊无 @mention 应该被忽略', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['photo'];

      const ctx = createPhotoCtx({ chat: { id: 123, type: 'group' } });
      await handler(ctx);

      expect(messageSender.sendTextReply).not.toHaveBeenCalled();
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('重复图片消息应该被忽略', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['photo'];

      // 需要提供 getFileLink 的 mock
      mockBot.telegram.getFileLink.mockResolvedValue({ href: 'https://example.com/photo.jpg' });
      // Mock global fetch
      const mockFetch = vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
      vi.stubGlobal('fetch', mockFetch);

      const ctx = createPhotoCtx({ message: { message_id: 5001, photo: [{ file_id: 'dup-photo', width: 800, height: 600 }] } });
      await handler(ctx);

      vi.mocked(messageSender.sendTextReply).mockClear();
      vi.mocked(runClaudeTask).mockClear();

      // 第二次同一 messageId
      await handler(ctx);
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('未授权用户应该被拒绝', async () => {
      const restrictedConfig = { ...mockConfig, allowedUserIds: ['allowed-user'] };
      setupTelegramHandlers(mockBot as any, restrictedConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['photo'];

      const ctx = createPhotoCtx({ from: { id: 789 }, message: { message_id: 5002, photo: [{ file_id: 'photo-1', width: 800, height: 600 }] } });
      await handler(ctx);

      expect(messageSender.sendTextReply).toHaveBeenCalledWith(
        '123',
        expect.stringContaining('没有访问权限'),
      );
    });

    it('图片下载成功应该入队并构建提示词', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['photo'];

      mockBot.telegram.getFileLink.mockResolvedValue({ href: 'https://example.com/photo.jpg' });
      const mockFetch = vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
      vi.stubGlobal('fetch', mockFetch);

      const ctx = createPhotoCtx({ message: { message_id: 6001, photo: [{ file_id: 'photo-ok', width: 800, height: 600 }] } });
      await handler(ctx);

      expect(mockBot.telegram.getFileLink).toHaveBeenCalledWith('photo-ok');
      expect(runClaudeTask).toHaveBeenCalled();
    });

    it('图片下载失败应该提示错误', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['photo'];

      mockBot.telegram.getFileLink.mockRejectedValue(new Error('network error'));

      const ctx = createPhotoCtx({ message: { message_id: 6002, photo: [{ file_id: 'photo-fail', width: 800, height: 600 }] } });
      await handler(ctx);

      expect(messageSender.sendTextReply).toHaveBeenCalledWith(
        '123',
        expect.stringContaining('图片下载失败'),
      );
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('带附言的图片应该在提示词中包含附言', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['photo'];

      mockBot.telegram.getFileLink.mockResolvedValue({ href: 'https://example.com/photo.jpg' });
      const mockFetch = vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { RequestQueue } = await import('../../../src/queue/request-queue.js');
      const rqInstance = vi.mocked(RequestQueue).mock.results[0]?.value;
      let capturedPrompt = '';
      if (rqInstance) {
        rqInstance.enqueue.mockImplementation((_userId: string, _convId: string, prompt: string, execute: (p: string) => void) => {
          capturedPrompt = prompt;
          execute(prompt);
          return 'running';
        });
      }

      const ctx = createPhotoCtx({
        message: {
          message_id: 6003,
          caption: '分析这张图片',
          photo: [{ file_id: 'photo-caption', width: 800, height: 600 }],
        },
      });
      await handler(ctx);

      expect(capturedPrompt).toContain('附言：分析这张图片');
    });

    it('图片队列满时应该返回拒绝消息', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['photo'];

      mockBot.telegram.getFileLink.mockResolvedValue({ href: 'https://example.com/photo.jpg' });
      const mockFetch = vi.fn().mockResolvedValue({
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      });
      vi.stubGlobal('fetch', mockFetch);

      const { RequestQueue } = await import('../../../src/queue/request-queue.js');
      const rqInstance = vi.mocked(RequestQueue).mock.results[0]?.value;
      if (rqInstance) {
        rqInstance.enqueue.mockReturnValueOnce('rejected');
      }

      const ctx = createPhotoCtx({ message: { message_id: 6004, photo: [{ file_id: 'photo-rej', width: 800, height: 600 }] } });
      await handler(ctx);

      expect(messageSender.sendTextReply).toHaveBeenCalledWith(
        '123',
        expect.stringContaining('队列已满'),
      );
    });
  });

  // --- callback query handlers ---

  describe('回调查询（停止按钮）处理', () => {
    it('没有 data 字段的回调应该被忽略', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['callback_query'];

      const ctx = {
        callbackQuery: {},
        from: { id: 456 },
        chat: { id: 123 },
        answerCbQuery: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.answerCbQuery).not.toHaveBeenCalled();
      expect(messageSender.updateMessage).not.toHaveBeenCalled();
    });

    it('停止按钮有对应任务时应该停止任务', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);

      // 先通过发送消息创建一个运行中的任务
      const textHandler = mockBot.handlers['text'];
      const mockSettle = vi.fn();
      const mockAbort = vi.fn();

      // 让 runClaudeTask 调用 onRegister 回调来注册任务
      vi.mocked(runClaudeTask).mockImplementation(async (_deps, _ctx, _prompt, adapter) => {
        adapter.onTaskReady({
            handle: { abort: mockAbort } as any,
            settle: mockSettle,
            startedAt: Date.now(),
            latestContent: '任务内容',
          });
        // 不 resolve，模拟任务仍在运行
      });

      const ctx = createTextCtxWithPrivate(7001, '运行任务');
      await textHandler(ctx);

      // 确认 runClaudeTask 被调用了，并且 msgId 是 'msg-think-123'
      expect(runClaudeTask).toHaveBeenCalled();

      // 现在模拟停止按钮回调
      const callbackHandler = mockBot.handlers['callback_query'];
      const cbCtx = {
        callbackQuery: { data: 'stop_msg-think-123' },
        from: { id: 456 },
        chat: { id: 123 },
        answerCbQuery: vi.fn(),
      };

      await callbackHandler(cbCtx);

      expect(mockSettle).toHaveBeenCalled();
      expect(mockAbort).toHaveBeenCalled();
      expect(messageSender.updateMessage).toHaveBeenCalledWith(
        '123',
        'msg-think-123',
        '任务内容',
        'error',
        '⏹️ 已停止',
      );
      expect(cbCtx.answerCbQuery).toHaveBeenCalledWith('已停止执行');
    });

    it('停止按钮没有对应任务时应该提示', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['callback_query'];

      const ctx = {
        callbackQuery: { data: 'stop_nonexistent-msg' },
        from: { id: 456 },
        chat: { id: 123 },
        answerCbQuery: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.answerCbQuery).toHaveBeenCalledWith('任务已完成或不存在');
      expect(messageSender.updateMessage).not.toHaveBeenCalled();
    });
  });

  // --- handleClaudeRequest internals ---

  describe('handleClaudeRequest 内部逻辑', () => {
    it('sendThinkingMessage 失败时应该提前返回', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      vi.mocked(messageSender.sendThinkingMessage).mockRejectedValueOnce(new Error('send failed'));

      const ctx = createTextCtxWithPrivate(8001, '测试');
      await handler(ctx);

      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('sendThinkingMessage 返回空值时应该提前返回', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      vi.mocked(messageSender.sendThinkingMessage).mockResolvedValueOnce('');

      const ctx = createTextCtxWithPrivate(8002, '测试空值');
      await handler(ctx);

      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('runClaudeTask 应该接收正确的参数', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      vi.mocked(messageSender.sendThinkingMessage).mockResolvedValueOnce('msg-test-456');

      const ctx = createTextCtxWithPrivate(8003, '分析代码');
      await handler(ctx);

      expect(runClaudeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining(mockConfig),
          sessionManager: expect.anything(),
          userCosts: expect.any(Map),
        }),
        expect.objectContaining({
          userId: '456',
          chatId: '123',
          workDir: '/work',
          platform: 'telegram',
        }),
        '分析代码',
        expect.objectContaining({
          throttleMs: 200,
          streamUpdate: expect.any(Function),
          sendComplete: expect.any(Function),
          sendError: expect.any(Function),
          extraCleanup: expect.any(Function),
          onTaskReady: expect.any(Function),
        }),
      );
    });

    it('adapter.streamUpdate 应该调用 updateMessage', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      vi.mocked(messageSender.sendThinkingMessage).mockResolvedValueOnce('msg-stream-789');

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const ctx = createTextCtxWithPrivate(8004, '流式测试');
      await handler(ctx);

      // 调用 streamUpdate
      capturedAdapter.streamUpdate('部分内容', '工具提示');

      expect(messageSender.updateMessage).toHaveBeenCalledWith(
        '123',
        'msg-stream-789',
        '部分内容',
        'streaming',
        '输出中...\n工具提示',
      );
    });

    it('adapter.streamUpdate 没有工具提示时应该只显示"输出中..."', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      vi.mocked(messageSender.sendThinkingMessage).mockResolvedValueOnce('msg-stream-no-tool');

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const ctx = createTextCtxWithPrivate(8005, '无工具测试');
      await handler(ctx);

      capturedAdapter.streamUpdate('内容', undefined);

      expect(messageSender.updateMessage).toHaveBeenCalledWith(
        '123',
        'msg-stream-no-tool',
        '内容',
        'streaming',
        '输出中...',
      );
    });

    it('adapter.sendComplete 应该调用 sendFinalMessages', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      vi.mocked(messageSender.sendThinkingMessage).mockResolvedValueOnce('msg-complete');

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const ctx = createTextCtxWithPrivate(8006, '完成测试');
      await handler(ctx);

      await capturedAdapter.sendComplete('最终内容', '完成备注');

      expect(messageSender.sendFinalMessages).toHaveBeenCalledWith(
        '123',
        'msg-complete',
        '最终内容',
        '完成备注',
      );
    });

    it('adapter.sendError 应该调用 updateMessage 显示错误', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      vi.mocked(messageSender.sendThinkingMessage).mockResolvedValueOnce('msg-error');

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const ctx = createTextCtxWithPrivate(8007, '错误测试');
      await handler(ctx);

      await capturedAdapter.sendError('超时');

      expect(messageSender.updateMessage).toHaveBeenCalledWith(
        '123',
        'msg-error',
        '错误：超时',
        'error',
        '执行失败',
      );
    });

    it('adapter.extraCleanup 应该停止 typing 并清理任务', async () => {
      setupTelegramHandlers(mockBot as any, mockConfig as any, mockSessionManager as any);
      const handler = mockBot.handlers['text'];

      const mockStopTyping = vi.fn();
      vi.mocked(messageSender.startTypingLoop).mockReturnValueOnce(mockStopTyping);
      vi.mocked(messageSender.sendThinkingMessage).mockResolvedValueOnce('msg-cleanup');

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const ctx = createTextCtxWithPrivate(8008, '清理测试');
      await handler(ctx);

      capturedAdapter.extraCleanup();

      expect(mockStopTyping).toHaveBeenCalled();
    });
  });
});

// Helper used across describe blocks for creating private text context
function createTextCtxWithPrivate(messageId: number, text: string) {
  return {
    chat: { id: 123, type: 'private' },
    from: { id: 456 },
    message: { message_id: messageId, text },
  };
}
