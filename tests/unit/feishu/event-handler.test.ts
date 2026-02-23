import { describe, it, expect, vi, beforeEach } from 'vitest';

// Create mock dispatcher first
const mockRegister = vi.fn();

// Mock Lark SDK at the top level
vi.mock('@larksuiteoapi/node-sdk', () => ({
  EventDispatcher: vi.fn().mockImplementation(function (this: any) {
    this.register = mockRegister;
  }),
}));

// Mock all other dependencies
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
    const threadSessions = new Map<string, any>();
    this.getSessionId = vi.fn();
    this.setSessionId = vi.fn();
    this.getConvId = vi.fn(() => 'conv-123');
    this.getWorkDir = vi.fn(() => '/work');
    this.setWorkDir = vi.fn((_userId: string, dir: string) => {
      if (dir === '/forbidden') throw new Error('目录不在允许范围内');
      return dir;
    });
    this.clearSession = vi.fn(() => true);
    this.getSessionIdForConv = vi.fn();
    this.setSessionIdForConv = vi.fn();
    this.getThreadSession = vi.fn((userId: string, threadId: string) => {
      return threadSessions.get(`${userId}:${threadId}`);
    });
    this.setThreadSession = vi.fn((userId: string, threadId: string, session: any) => {
      threadSessions.set(`${userId}:${threadId}`, session);
    });
    this.getSessionIdForThread = vi.fn();
    this.setSessionIdForThread = vi.fn();
    this.getModel = vi.fn();
    this.removeThreadByRootMessageId = vi.fn(() => false);
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

vi.mock('../../../src/feishu/message-sender.js', () => ({
  sendThinkingCard: vi.fn().mockResolvedValue({ messageId: 'msg-123', cardId: 'card-abc' }),
  streamContentUpdate: vi.fn().mockResolvedValue(undefined),
  sendFinalCards: vi.fn().mockResolvedValue(undefined),
  sendErrorCard: vi.fn().mockResolvedValue(undefined),
  sendTextReply: vi.fn().mockResolvedValue(undefined),
  sendPermissionCard: vi.fn().mockResolvedValue('perm-msg-123'),
  updatePermissionCard: vi.fn().mockResolvedValue(undefined),
  fetchThreadDescription: vi.fn().mockResolvedValue('话题描述内容'),
}));

vi.mock('../../../src/feishu/cardkit-manager.js', () => ({
  destroySession: vi.fn(),
  updateCardFull: vi.fn().mockResolvedValue(undefined),
  disableStreaming: vi.fn().mockResolvedValue(undefined),
}));

const mockRunClaudeTask = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/shared/claude-task.js', () => ({
  runClaudeTask: (...args: any[]) => mockRunClaudeTask(...args),
}));

vi.mock('../../../src/claude/cli-runner.js', () => ({
  runClaude: vi.fn(() => ({
    process: { kill: vi.fn() },
    abort: vi.fn(),
  })),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{}'),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((path, args, opts, cb) => {
    cb(null, 'v1.0.0', '');
  }),
}));

vi.mock('../../../src/hook/permission-server.js', () => ({
  registerPermissionSender: vi.fn(),
  resolveLatestPermission: vi.fn(),
  getPendingCount: vi.fn(() => 0),
  listPending: vi.fn(() => []),
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
  CARDKIT_THROTTLE_MS: 80,
  READ_ONLY_TOOLS: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoRead'],
  MAX_STREAMING_CONTENT_LENGTH: 25000,
  MAX_CARD_CONTENT_LENGTH: 3800,
  IMAGE_DIR: '/tmp/cc-im-images',
}));

vi.mock('../../../src/commands/handler.js', () => {
  const { sendTextReply } = vi.importActual('../../../src/feishu/message-sender.js') as any;

  return {
    CommandHandler: vi.fn().mockImplementation(function (this: any, deps: any) {
      this.deps = deps;
      this.updateRunningTasksSize = vi.fn();

      // Mock handlers that actually call sendTextReply so tests can verify them
      this.handleHelp = vi.fn(async (chatId: string, platform: string) => {
        await deps.sender.sendTextReply(chatId, '可用命令:\n...');
        return true;
      });

      this.handleNew = vi.fn(async (chatId: string, userId: string) => {
        await deps.sender.sendTextReply(chatId, '✅ 已开始新会话');
        return true;
      });

      this.handleCd = vi.fn(async (chatId: string, userId: string, args: string) => {
        if (args.includes('/forbidden')) {
          await deps.sender.sendTextReply(chatId, '目录不在允许范围内');
        } else {
          await deps.sender.sendTextReply(chatId, '工作目录已切换');
        }
        return true;
      });

      this.handlePwd = vi.fn(async (chatId: string, userId: string) => {
        await deps.sender.sendTextReply(chatId, '当前工作目录: /work');
        return true;
      });

      this.handleList = vi.fn(async (chatId: string, userId: string) => {
        await deps.sender.sendTextReply(chatId, 'Claude Code 工作区列表');
        return true;
      });

      this.handleCost = vi.fn(async (chatId: string, userId: string) => {
        await deps.sender.sendTextReply(chatId, '暂无费用记录');
        return true;
      });

      this.handleStatus = vi.fn(async (chatId: string, userId: string) => {
        await deps.sender.sendTextReply(chatId, 'Claude Code 状态');
        return true;
      });

      this.handleModel = vi.fn(async (chatId: string, args: string) => {
        if (!args.trim()) {
          await deps.sender.sendTextReply(chatId, '当前模型: 默认');
        } else {
          await deps.sender.sendTextReply(chatId, `模型已切换为: ${args.trim()}`);
        }
        return true;
      });

      this.handleDoctor = vi.fn(async (chatId: string, userId: string) => {
        await deps.sender.sendTextReply(chatId, 'Claude Code 健康检查');
        return true;
      });

      this.handleCompact = vi.fn().mockResolvedValue(true);
      this.handleTodos = vi.fn().mockResolvedValue(true);
      this.handleAllow = vi.fn().mockResolvedValue(true);
      this.handleDeny = vi.fn().mockResolvedValue(true);
      this.handleAllowAll = vi.fn().mockResolvedValue(true);
      this.handlePending = vi.fn().mockResolvedValue(true);
      this.handleThreads = vi.fn().mockResolvedValue(true);

      // dispatch 委托给各个 handler mock
      this.dispatch = vi.fn(async (text: string, chatId: string, userId: string, platform: string, _handleClaudeRequest: any, threadCtx?: any) => {
        const t = text.trim();
        if (platform === 'telegram' && t === '/start') { await deps.sender.sendTextReply(chatId, '欢迎使用 Claude Code Bot!'); return true; }
        if (t === '/help') return this.handleHelp(chatId, platform, threadCtx);
        if (t === '/new') return this.handleNew(chatId, userId, threadCtx);
        if (t === '/pwd') return this.handlePwd(chatId, userId, threadCtx);
        if (t === '/list') return this.handleList(chatId, userId, threadCtx);
        if (t === '/cost') return this.handleCost(chatId, userId, threadCtx);
        if (t === '/status') return this.handleStatus(chatId, userId, threadCtx);
        if (t === '/doctor') return this.handleDoctor(chatId, userId, threadCtx);
        if (t === '/allow' || t === '/y') return this.handleAllow(chatId, threadCtx);
        if (t === '/deny' || t === '/n') return this.handleDeny(chatId, threadCtx);
        if (t === '/allowall') return this.handleAllowAll(chatId, threadCtx);
        if (t === '/pending') return this.handlePending(chatId, threadCtx);
        if (t === '/threads' && platform === 'feishu') return this.handleThreads(chatId, userId, threadCtx);
        if (t === '/cd' || t.startsWith('/cd ')) return this.handleCd(chatId, userId, t.slice(3), threadCtx);
        if (t === '/model' || t.startsWith('/model ')) return this.handleModel(chatId, t.slice(6), threadCtx);
        if (t === '/compact' || t.startsWith('/compact ')) return this.handleCompact(chatId, userId, t.slice(8), _handleClaudeRequest, threadCtx);
        const cmd = t.split(/\s+/)[0];
        const { TERMINAL_ONLY_COMMANDS } = await import('../../../src/constants.js');
        if (TERMINAL_ONLY_COMMANDS.has(cmd)) { await deps.sender.sendTextReply(chatId, `${cmd} 命令仅在终端交互模式下可用。\n\n输入 /help 查看可用命令。`, threadCtx); return true; }
        return false;
      });
    }),
  };
});

// Import after mocks
import { createEventDispatcher, parsePostContent } from '../../../src/feishu/event-handler.js';
import * as messageSender from '../../../src/feishu/message-sender.js';
import * as cardkitManager from '../../../src/feishu/cardkit-manager.js';

describe('Event Handler', () => {
  const mockConfig = {
    enabledPlatforms: ['feishu' as const],
    feishuAppId: 'test-app-id',
    feishuAppSecret: 'test-secret',
    telegramBotToken: '',
    allowedUserIds: [],
    claudeCliPath: '/claude',
    claudeWorkDir: '/work',
    allowedBaseDirs: ['/work'],
    claudeSkipPermissions: false,
    claudeTimeoutMs: 300000,
    hookPort: 18900,
  };

  let mockDispatcher: any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Helper function to get message handler safely
  function getMessageHandler() {
    const call = mockRegister.mock.calls.find((call: any) => 'im.message.receive_v1' in call[0]);
    if (!call) throw new Error('Message handler not registered');
    return call[0]['im.message.receive_v1'];
  }

  function getCardActionHandler() {
    const call = mockRegister.mock.calls.find((call: any) => 'card.action.trigger' in call[0]);
    if (!call) throw new Error('Card action handler not registered');
    return call[0]['card.action.trigger'];
  }

  function getRecalledHandler() {
    const call = mockRegister.mock.calls.find((call: any) => 'im.message.recalled_v1' in call[0]);
    if (!call) throw new Error('Recalled handler not registered');
    return call[0]['im.message.recalled_v1'];
  }

  it('应该创建 EventDispatcher', () => {
    const dispatcher = createEventDispatcher(mockConfig);
    expect(dispatcher).toBeDefined();
  });

  it('应该注册消息接收事件', async () => {
    createEventDispatcher(mockConfig);

    expect(mockRegister).toHaveBeenCalled();
    const registerCalls = mockRegister.mock.calls;

    // 应该注册 im.message.receive_v1 和 card.action.trigger
    const eventTypes = registerCalls.map((call: any) => Object.keys(call[0])[0]);
    expect(eventTypes).toContain('im.message.receive_v1');
    expect(eventTypes).toContain('card.action.trigger');
  });

  it('命令被 dispatch 拦截后不应调用 runClaudeTask', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-help',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/help' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalled();
    expect(mockRunClaudeTask).not.toHaveBeenCalled();
  });

  it('终端命令应该被拦截', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-config',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/config' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('仅在终端交互模式下可用'),
      undefined,
    );
  });

  it('非文本消息应该返回提示', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-sticker',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'sticker',
        content: '{}',
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      '目前仅支持文本和图片消息。'
    );
  });

  it('群聊无 @mention 应该被忽略', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-group',
        chat_id: 'chat-group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'Hello' }),
        mentions: [], // 无 @mention
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    // 不应该发送任何回复
    expect(messageSender.sendTextReply).not.toHaveBeenCalled();
  });

  it('相同 messageId 应该只处理一次（去重）', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-duplicate',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/help' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    // 第一次处理
    await messageHandler(messageData);
    const firstCallCount = (messageSender.sendTextReply as any).mock.calls.length;

    // 第二次处理（相同 messageId）
    await messageHandler(messageData);
    const secondCallCount = (messageSender.sendTextReply as any).mock.calls.length;

    // 应该只处理一次
    expect(secondCallCount).toBe(firstCallCount);
  });

  it('没有发送者 ID 应该被忽略', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-no-sender',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'Hello' }),
      },
      sender: {},
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).not.toHaveBeenCalled();
  });

  it('访问控制应该拦截未授权用户', async () => {
    const restrictedConfig = {
      ...mockConfig,
      allowedUserIds: ['allowed-user'],
    };
    createEventDispatcher(restrictedConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-denied',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'Hello' }),
      },
      sender: {
        sender_id: { open_id: 'unauthorized-user' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('没有使用此机器人的权限')
    );
  });

  it('空文本消息应该被忽略', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-empty',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '   ' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).not.toHaveBeenCalled();
  });

  it('消息内容解析失败应该被忽略', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-invalid',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: 'invalid json',
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).not.toHaveBeenCalled();
  });


  it('应该去除飞书 @mention 占位符', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-mention',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 /help' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('可用命令')
    );
  });

  it('群聊主聊天区应该使用默认会话（不创建话题）', async () => {
    createEventDispatcher(mockConfig);
    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-group-main',
        chat_id: 'chat-group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 Hello in main chat' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'bot-id' }, name: 'Bot' }],
        // 无 thread_id 和 root_id
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    // 应该调用 sendThinkingCard，但不传递 threadCtx
    expect(messageSender.sendThinkingCard).toHaveBeenCalledWith('chat-group', undefined);
  });

  it('群聊话题内应该使用话题会话', async () => {
    createEventDispatcher(mockConfig);
    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-in-thread',
        chat_id: 'chat-group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'Reply in thread' }),
        thread_id: 'omt_abc123',
        root_id: 'om_root456',
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    // 应该调用 sendThinkingCard，传递 threadCtx
    expect(messageSender.sendThinkingCard).toHaveBeenCalledWith(
      'chat-group',
      { rootMessageId: 'om_root456', threadId: 'omt_abc123' }
    );
  });

  it('话题群（topic）应该使用话题会话', async () => {
    createEventDispatcher(mockConfig);
    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-in-topic-group',
        chat_id: 'chat-topic',
        chat_type: 'topic',
        message_type: 'text',
        content: JSON.stringify({ text: 'Message in topic group' }),
        thread_id: 'omt_topic123',
        root_id: 'om_topicroot456',
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    // 话题群消息应该走话题会话路由，传递 threadCtx
    expect(messageSender.sendThinkingCard).toHaveBeenCalledWith(
      'chat-topic',
      { rootMessageId: 'om_topicroot456', threadId: 'omt_topic123' }
    );
  });

  // ─── card.action.trigger 测试 ───

  describe('card.action.trigger', () => {
    it('无 userId 时忽略', async () => {
      createEventDispatcher(mockConfig);
      const handler = getCardActionHandler();

      await handler({
        action: { value: { action: 'stop', card_id: 'card-1' } },
        // 无 operator 和 sender
      });

      // 不应该有任何副作用
      expect(cardkitManager.disableStreaming).not.toHaveBeenCalled();
    });

    it('action 字段不是 string 时忽略', async () => {
      createEventDispatcher(mockConfig);
      const handler = getCardActionHandler();

      await handler({
        action: { value: { action: 123 } },
        operator: { open_id: 'user-123' },
      });

      expect(cardkitManager.disableStreaming).not.toHaveBeenCalled();
    });

    it('解析 action value 异常时忽略', async () => {
      createEventDispatcher(mockConfig);
      const handler = getCardActionHandler();

      await handler({
        action: { value: 'not-valid-json{' },
        operator: { open_id: 'user-123' },
      });

      expect(cardkitManager.disableStreaming).not.toHaveBeenCalled();
    });

    it('stop action 无 card_id 时忽略', async () => {
      createEventDispatcher(mockConfig);
      const handler = getCardActionHandler();

      await handler({
        action: { value: { action: 'stop' } },
        operator: { open_id: 'user-123' },
      });

      expect(cardkitManager.disableStreaming).not.toHaveBeenCalled();
    });

    it('从 sender.sender_id.open_id 获取 userId', async () => {
      createEventDispatcher(mockConfig);
      const handler = getCardActionHandler();

      await handler({
        action: { value: { action: 'stop', card_id: 'card-sender' } },
        sender: { sender_id: { open_id: 'user-from-sender' } },
      });

      // 不抛出，正常处理（只是无匹配任务）
    });
  });

  // ─── im.message.recalled_v1 测试 ───

  describe('im.message.recalled_v1', () => {
    it('有 message_id 时调用 removeThreadByRootMessageId', async () => {
      createEventDispatcher(mockConfig);
      const handler = getRecalledHandler();

      await handler({ message_id: 'msg-recalled-123' });

      // removeThreadByRootMessageId 在 SessionManager mock 中
      // 验证处理器不抛出
    });

    it('无 message_id 时忽略', async () => {
      createEventDispatcher(mockConfig);
      const handler = getRecalledHandler();

      await handler({});
      // 不应抛出
    });
  });

  // ─── handleClaudeRequest 内部逻辑 ───

  describe('handleClaudeRequest', () => {
    it('sendThinkingCard 失败时提前返回', async () => {
      vi.mocked(messageSender.sendThinkingCard).mockRejectedValueOnce(new Error('card create failed'));

      createEventDispatcher(mockConfig);
      const messageHandler = getMessageHandler();

      await messageHandler({
        message: {
          message_id: 'msg-think-fail',
          chat_id: 'chat-123',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello Claude' }),
        },
        sender: { sender_id: { open_id: 'user-123' } },
      });

      // runClaudeTask 不应被调用
      expect(mockRunClaudeTask).not.toHaveBeenCalled();
    });

    it('sendThinkingCard 返回无 cardId 时提前返回', async () => {
      vi.mocked(messageSender.sendThinkingCard).mockResolvedValueOnce({ messageId: 'msg-1', cardId: '' });

      createEventDispatcher(mockConfig);
      const messageHandler = getMessageHandler();

      await messageHandler({
        message: {
          message_id: 'msg-no-card',
          chat_id: 'chat-123',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'Hello Claude' }),
        },
        sender: { sender_id: { open_id: 'user-123' } },
      });

      expect(mockRunClaudeTask).not.toHaveBeenCalled();
    });

    it('runClaudeTask 接收正确的 context', async () => {
      createEventDispatcher(mockConfig);
      const messageHandler = getMessageHandler();

      await messageHandler({
        message: {
          message_id: 'msg-ctx-check',
          chat_id: 'chat-123',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'context check' }),
        },
        sender: { sender_id: { open_id: 'user-123' } },
      });

      expect(mockRunClaudeTask).toHaveBeenCalledWith(
        mockConfig,
        expect.any(Object), // sessionManager
        expect.objectContaining({
          userId: 'user-123',
          chatId: 'chat-123',
          platform: 'feishu',
        }),
        'context check',
        expect.objectContaining({
          streamUpdate: expect.any(Function),
          sendComplete: expect.any(Function),
          sendError: expect.any(Function),
          onThinkingToText: expect.any(Function),
          extraCleanup: expect.any(Function),
        }),
        expect.any(Map), // userCosts
        expect.any(Function), // onRegister
        expect.any(Function), // onFirstContent
      );
    });

    it('adapter.sendComplete 调用 sendFinalCards', async () => {
      mockRunClaudeTask.mockImplementationOnce(async (_cfg: any, _sm: any, _ctx: any, _prompt: any, adapter: any) => {
        await adapter.sendComplete('final content', 'done note', 'thinking text');
      });

      createEventDispatcher(mockConfig);
      const messageHandler = getMessageHandler();

      await messageHandler({
        message: {
          message_id: 'msg-complete',
          chat_id: 'chat-123',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'test complete' }),
        },
        sender: { sender_id: { open_id: 'user-123' } },
      });

      expect(messageSender.sendFinalCards).toHaveBeenCalledWith(
        'chat-123', 'msg-123', 'card-abc',
        'final content', 'done note',
        undefined, // threadCtx
        'thinking text',
      );
    });

    it('adapter.sendError 调用 sendErrorCard', async () => {
      mockRunClaudeTask.mockImplementationOnce(async (_cfg: any, _sm: any, _ctx: any, _prompt: any, adapter: any) => {
        await adapter.sendError('something went wrong');
      });

      createEventDispatcher(mockConfig);
      const messageHandler = getMessageHandler();

      await messageHandler({
        message: {
          message_id: 'msg-err',
          chat_id: 'chat-123',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'test error' }),
        },
        sender: { sender_id: { open_id: 'user-123' } },
      });

      expect(messageSender.sendErrorCard).toHaveBeenCalledWith('card-abc', 'something went wrong');
    });

    it('adapter.streamUpdate 调用 streamContentUpdate', async () => {
      mockRunClaudeTask.mockImplementationOnce(async (_cfg: any, _sm: any, _ctx: any, _prompt: any, adapter: any) => {
        adapter.streamUpdate('streaming content', 'tool note');
      });

      createEventDispatcher(mockConfig);
      const messageHandler = getMessageHandler();

      await messageHandler({
        message: {
          message_id: 'msg-stream',
          chat_id: 'chat-123',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'test stream' }),
        },
        sender: { sender_id: { open_id: 'user-123' } },
      });

      expect(messageSender.streamContentUpdate).toHaveBeenCalledWith('card-abc', 'streaming content', 'tool note');
    });

    it('adapter.onThinkingToText 调用 updateCardFull 重置卡片', async () => {
      mockRunClaudeTask.mockImplementationOnce(async (_cfg: any, _sm: any, _ctx: any, _prompt: any, adapter: any) => {
        adapter.onThinkingToText('new content');
      });

      createEventDispatcher(mockConfig);
      const messageHandler = getMessageHandler();

      await messageHandler({
        message: {
          message_id: 'msg-think-switch',
          chat_id: 'chat-123',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'test thinking switch' }),
        },
        sender: { sender_id: { open_id: 'user-123' } },
      });

      expect(cardkitManager.updateCardFull).toHaveBeenCalledWith('card-abc', expect.any(String));
    });
  });
});

describe('parsePostContent', () => {
  it('提取图片和文字', () => {
    const post = {
      title: '标题',
      content: [
        [
          { tag: 'text', text: '第一行' },
          { tag: 'a', href: 'http://example.com', text: '链接' },
        ],
        [
          { tag: 'img', image_key: 'img_key_1' },
        ],
        [
          { tag: 'text', text: '第二行' },
        ],
      ],
    };
    const result = parsePostContent(post);
    expect(result.imageKeys).toEqual(['img_key_1']);
    expect(result.text).toBe('第一行\n第二行');
  });

  it('提取多张图片', () => {
    const post = {
      content: [
        [{ tag: 'img', image_key: 'img_a' }],
        [{ tag: 'text', text: '中间文字' }],
        [{ tag: 'img', image_key: 'img_b' }],
        [{ tag: 'img', image_key: 'img_c' }],
      ],
    };
    const result = parsePostContent(post);
    expect(result.imageKeys).toEqual(['img_a', 'img_b', 'img_c']);
    expect(result.text).toBe('中间文字');
  });

  it('只有文字没有图片', () => {
    const post = {
      content: [
        [{ tag: 'text', text: '纯文字消息' }],
        [{ tag: 'text', text: '第二段' }],
      ],
    };
    const result = parsePostContent(post);
    expect(result.imageKeys).toEqual([]);
    expect(result.text).toBe('纯文字消息\n第二段');
  });

  it('只有图片没有文字', () => {
    const post = {
      content: [
        [{ tag: 'img', image_key: 'img_only' }],
      ],
    };
    const result = parsePostContent(post);
    expect(result.imageKeys).toEqual(['img_only']);
    expect(result.text).toBeNull();
  });

  it('空 content 数组', () => {
    const result = parsePostContent({ content: [] });
    expect(result.imageKeys).toEqual([]);
    expect(result.text).toBeNull();
  });

  it('content 不是数组', () => {
    const result = parsePostContent({ content: 'invalid' as any });
    expect(result.imageKeys).toEqual([]);
    expect(result.text).toBeNull();
  });

  it('无 content 字段', () => {
    const result = parsePostContent({} as any);
    expect(result.imageKeys).toEqual([]);
    expect(result.text).toBeNull();
  });

  it('忽略非 img/text 标签', () => {
    const post = {
      content: [
        [
          { tag: 'text', text: '文字' },
          { tag: 'a', href: 'http://example.com', text: '链接文字' },
          { tag: 'at', user_id: 'ou_123', user_name: '用户' },
          { tag: 'emotion', emoji_type: 'SMILE' },
          { tag: 'img', image_key: 'img_1' },
        ],
      ],
    };
    const result = parsePostContent(post);
    expect(result.imageKeys).toEqual(['img_1']);
    expect(result.text).toBe('文字');
  });

  it('跳过 null 和非对象元素', () => {
    const post = {
      content: [
        [null, undefined, 42, 'string', { tag: 'text', text: '有效' }],
      ],
    };
    const result = parsePostContent(post as any);
    expect(result.text).toBe('有效');
    expect(result.imageKeys).toEqual([]);
  });

  it('跳过非数组的 block', () => {
    const post = {
      content: [
        'not-an-array',
        [{ tag: 'text', text: '有效块' }],
        null,
      ] as any,
    };
    const result = parsePostContent(post);
    expect(result.text).toBe('有效块');
  });

  it('忽略空 text 和空 image_key', () => {
    const post = {
      content: [
        [
          { tag: 'text', text: '' },
          { tag: 'img', image_key: '' },
          { tag: 'text', text: '非空' },
          { tag: 'img', image_key: 'valid_key' },
        ],
      ],
    };
    const result = parsePostContent(post);
    expect(result.text).toBe('非空');
    expect(result.imageKeys).toEqual(['valid_key']);
  });
});
