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
import { createEventDispatcher } from '../../../src/feishu/event-handler.js';
import * as messageSender from '../../../src/feishu/message-sender.js';

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

  it('/help 命令应该返回帮助信息', async () => {
    createEventDispatcher(mockConfig);

    // 获取 im.message.receive_v1 的处理器
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

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('可用命令')
    );
  });

  it('/new 命令应该开始新会话', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-new',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/new' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('已开始新会话')
    );
  });

  it('/pwd 命令应该返回当前目录', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-pwd',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/pwd' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('/work')
    );
  });

  it('/cd 成功应该切换目录', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-cd',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/cd /work/subdir' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('工作目录已切换')
    );
  });

  it('/cd 失败应该返回错误', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-cd-fail',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/cd /forbidden' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('目录不在允许范围内')
    );
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

  it('/status 命令应该返回状态信息', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-status',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/status' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('Claude Code 状态')
    );
  });

  it('/model 无参数应该显示当前模型', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-model',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/model' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('当前模型')
    );
  });

  it('/model 有参数应该切换模型', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-model-switch',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/model opus' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('模型已切换为: opus')
    );
  });

  it('/doctor 命令应该返回健康检查信息', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-doctor',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/doctor' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('健康检查')
    );
  });

  it('/cost 无记录应该返回提示', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-cost',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/cost' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalledWith(
      'chat-123',
      expect.stringContaining('暂无费用记录')
    );
  });

  it('/list 命令应该列出工作区', async () => {
    createEventDispatcher(mockConfig);

    const messageHandler = getMessageHandler();

    const messageData = {
      message: {
        message_id: 'msg-list',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/list' }),
      },
      sender: {
        sender_id: { open_id: 'user-123' },
      },
    };

    await messageHandler(messageData);

    expect(messageSender.sendTextReply).toHaveBeenCalled();
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
});
