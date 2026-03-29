import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// Mock all dependencies at the top level BEFORE imports

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
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

vi.mock('../../../src/hook/permission-server.js', () => ({
  registerPermissionSender: vi.fn(),
  registerWatchSender: vi.fn(),
  resolvePermissionById: vi.fn(),
}));

vi.mock('../../../src/shared/task-cleanup.js', () => ({
  startTaskCleanup: vi.fn(() => vi.fn()),
}));

vi.mock('../../../src/shared/active-chats.js', () => ({
  setActiveChatId: vi.fn(),
}));

vi.mock('../../../src/shared/claude-task.js', () => ({
  runClaudeTask: vi.fn().mockResolvedValue(undefined),
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

vi.mock('../../../src/wecom/message-sender.js', () => ({
  createWecomSender: vi.fn(() => ({
    sendTextReply: vi.fn().mockResolvedValue(undefined),
    initStream: vi.fn(),
    sendStreamUpdate: vi.fn().mockResolvedValue(undefined),
    resetStreamForTextSwitch: vi.fn().mockResolvedValue(undefined),
    sendStreamComplete: vi.fn().mockResolvedValue(undefined),
    sendStreamError: vi.fn().mockResolvedValue(undefined),
    cleanupStream: vi.fn(),
    sendPermissionCard: vi.fn().mockResolvedValue(''),
    updatePermissionCard: vi.fn().mockResolvedValue(undefined),
    sendImage: vi.fn().mockResolvedValue(undefined),
  })),
  sendTextReply: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/commands/handler.js', () => ({
  CommandHandler: vi.fn().mockImplementation(function (this: any, deps: any) {
    this.deps = deps;
    this.dispatch = vi.fn(async (text: string, chatId: string, _userId: string, platform: string, _handleClaudeRequest: any) => {
      const t = text.trim();
      if (t === '/help') { await deps.sender.sendTextReply(chatId, '可用命令:\n...'); return true; }
      if (t === '/new') { await deps.sender.sendTextReply(chatId, '✅ 已开始新会话'); return true; }
      if (t === '/pwd') { await deps.sender.sendTextReply(chatId, '当前工作目录: /work'); return true; }
      return false;
    });
  }),
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
  WECOM_THROTTLE_MS: 200,
  IMAGE_DIR: '/tmp/cc-im-images',
}));

vi.mock('../../../src/claude/cli-runner.js', () => ({
  runClaude: vi.fn(() => ({
    process: { kill: vi.fn() },
    abort: vi.fn(),
  })),
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
import { setupWecomHandlers } from '../../../src/wecom/event-handler.js';
import { createWecomSender } from '../../../src/wecom/message-sender.js';
import { runClaudeTask } from '../../../src/shared/claude-task.js';
import { setActiveChatId } from '../../../src/shared/active-chats.js';
import { registerPermissionSender, resolvePermissionById } from '../../../src/hook/permission-server.js';
import { startTaskCleanup } from '../../../src/shared/task-cleanup.js';

// Helper to create a mock WSClient based on EventEmitter
function createMockWSClient() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    downloadFile: vi.fn().mockResolvedValue({ buffer: Buffer.from('img'), filename: 'test.jpg' }),
    updateTemplateCard: vi.fn().mockResolvedValue({}),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    replyStream: vi.fn().mockResolvedValue(undefined),
    replyStreamWithCard: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
  });
}

const mockConfig = {
  enabledPlatforms: ['wecom' as const],
  wecomBotId: 'bot-123',
  wecomBotSecret: 'secret-123',
  allowedUserIds: [] as string[],
  claudeCliPath: '/claude',
  claudeWorkDir: '/work',
  allowedBaseDirs: ['/work'],
  claudeSkipPermissions: false,
  claudeTimeoutMs: 600000,
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

describe('WeChat Work (WeCom) Event Handler', () => {
  let mockClient: ReturnType<typeof createMockWSClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockWSClient();
  });

  // --- setup & lifecycle ---

  it('should export setupWecomHandlers', () => {
    expect(typeof setupWecomHandlers).toBe('function');
  });

  it('should return handle with stop and getRunningTaskCount', () => {
    const handle = setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);
    expect(typeof handle.stop).toBe('function');
    expect(typeof handle.getRunningTaskCount).toBe('function');
    expect(handle.getRunningTaskCount()).toBe(0);
  });

  it('should register event listeners', () => {
    setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

    // EventEmitter3 stores listeners - check they were registered
    expect(mockClient.listenerCount('message.text')).toBe(1);
    expect(mockClient.listenerCount('message.voice')).toBe(1);
    expect(mockClient.listenerCount('message.image')).toBe(1);
    expect(mockClient.listenerCount('message.mixed')).toBe(1);
    expect(mockClient.listenerCount('event.template_card_event')).toBe(1);
  });

  it('should register permission sender', () => {
    setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);
    expect(registerPermissionSender).toHaveBeenCalledWith('wecom', expect.objectContaining({
      sendPermissionCard: expect.any(Function),
      updatePermissionCard: expect.any(Function),
    }));
  });

  it('should start task cleanup', () => {
    setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);
    expect(startTaskCleanup).toHaveBeenCalled();
  });

  // --- text message processing ---

  describe('text message processing', () => {
    function emitTextMessage(client: ReturnType<typeof createMockWSClient>, overrides: Record<string, any> = {}) {
      const body = {
        msgid: `msg-${Date.now()}`,
        chattype: 'single',
        from: { userid: 'user1' },
        msgtype: 'text',
        text: { content: 'Hello' },
        ...overrides,
      };
      const frame = { cmd: 'aibot_msg_callback', headers: { req_id: 'req-1' }, body };
      client.emit('message.text', frame);
      return frame;
    }

    it('should process normal text messages and call runClaudeTask', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      emitTextMessage(mockClient, { msgid: 'msg-text-1', text: { content: '帮我写代码' } });
      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalled();
      });
    });

    it('should handle duplicate messages', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      const body = { msgid: 'dup-msg-1', text: { content: 'Hello' } };
      emitTextMessage(mockClient, body);
      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalledTimes(1);
      });

      vi.mocked(runClaudeTask).mockClear();
      emitTextMessage(mockClient, body);
      // Give a tick for async processing
      await new Promise(r => setTimeout(r, 10));
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('should deny unauthorized users', async () => {
      const restrictedConfig = { ...mockConfig, allowedUserIds: ['allowed-user'] };
      setupWecomHandlers(mockClient as any, restrictedConfig as any, mockSessionManager as any);

      emitTextMessage(mockClient, { msgid: 'msg-unauth-1', from: { userid: 'blocked-user' } });
      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await vi.waitFor(() => {
        expect(senderInstance.sendTextReply).toHaveBeenCalledWith(
          'blocked-user',
          expect.stringContaining('没有访问权限'),
        );
      });
    });

    it('should set active chat ID', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      emitTextMessage(mockClient, { msgid: 'msg-active-1' });
      await vi.waitFor(() => {
        expect(setActiveChatId).toHaveBeenCalledWith('wecom', 'user1');
      });
    });

    it('should route commands to commandHandler', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      emitTextMessage(mockClient, { msgid: 'msg-help-1', text: { content: '/help' } });
      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await vi.waitFor(() => {
        expect(senderInstance.sendTextReply).toHaveBeenCalledWith(
          expect.any(String),
          expect.stringContaining('可用命令'),
        );
      });
      expect(runClaudeTask).not.toHaveBeenCalled();
    });

    it('should handle /stop command', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      // No running tasks
      emitTextMessage(mockClient, { msgid: 'msg-stop-1', text: { content: '/stop' } });
      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await vi.waitFor(() => {
        expect(senderInstance.sendTextReply).toHaveBeenCalledWith(
          'user1',
          '当前没有运行中的任务',
        );
      });
    });

    it('should handle queue rejected', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      const { RequestQueue } = await import('../../../src/queue/request-queue.js');
      const rqInstance = vi.mocked(RequestQueue).mock.results[0]?.value;
      if (rqInstance) {
        rqInstance.enqueue.mockReturnValueOnce('rejected');
      }

      emitTextMessage(mockClient, { msgid: 'msg-rej-1', text: { content: '请求' } });
      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await vi.waitFor(() => {
        expect(senderInstance.sendTextReply).toHaveBeenCalledWith(
          'user1',
          expect.stringContaining('队列已满'),
        );
      });
    });

    it('should handle queue queued', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      const { RequestQueue } = await import('../../../src/queue/request-queue.js');
      const rqInstance = vi.mocked(RequestQueue).mock.results[0]?.value;
      if (rqInstance) {
        rqInstance.enqueue.mockReturnValueOnce('queued');
      }

      emitTextMessage(mockClient, { msgid: 'msg-queued-1', text: { content: '请求' } });
      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await vi.waitFor(() => {
        expect(senderInstance.sendTextReply).toHaveBeenCalledWith(
          'user1',
          expect.stringContaining('排队等待'),
        );
      });
    });

    it('should use chatId from chatid field for group messages', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      emitTextMessage(mockClient, {
        msgid: 'msg-group-1',
        chattype: 'group',
        chatid: 'group-chat-1',
        text: { content: '群聊消息' },
      });

      await vi.waitFor(() => {
        expect(setActiveChatId).toHaveBeenCalledWith('wecom', 'group-chat-1');
      });
    });
  });

  // --- voice message processing ---

  describe('voice message processing', () => {
    it('should process voice messages (transcribed text)', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-v1' },
        body: {
          msgid: 'voice-1',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'voice',
          voice: { content: '语音转文字内容' },
        },
      };
      mockClient.emit('message.voice', frame);

      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalled();
      });
    });
  });

  // --- image message processing ---

  describe('image message processing', () => {
    it('should download image and route to Claude', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-i1' },
        body: {
          msgid: 'img-1',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'image',
          image: { url: 'https://example.com/img.jpg', aeskey: 'key123' },
        },
      };
      mockClient.emit('message.image', frame);

      await vi.waitFor(() => {
        expect(mockClient.downloadFile).toHaveBeenCalledWith('https://example.com/img.jpg', 'key123');
        expect(runClaudeTask).toHaveBeenCalled();
      });
    });

    it('should handle image download failure', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);
      mockClient.downloadFile.mockRejectedValueOnce(new Error('download failed'));

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-i2' },
        body: {
          msgid: 'img-fail-1',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'image',
          image: { url: 'https://example.com/img.jpg' },
        },
      };
      mockClient.emit('message.image', frame);

      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await vi.waitFor(() => {
        expect(senderInstance.sendTextReply).toHaveBeenCalledWith(
          'user1',
          expect.stringContaining('图片下载失败'),
        );
      });
      expect(runClaudeTask).not.toHaveBeenCalled();
    });
  });

  // --- mixed message processing ---

  describe('mixed message processing', () => {
    it('should extract text and images from mixed messages', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-m1' },
        body: {
          msgid: 'mixed-1',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'mixed',
          mixed: {
            msg_item: [
              { msgtype: 'text', text: { content: '看这张图' } },
              { msgtype: 'image', image: { url: 'https://example.com/img.jpg', aeskey: 'key1' } },
            ],
          },
        },
      };
      mockClient.emit('message.mixed', frame);

      await vi.waitFor(() => {
        expect(mockClient.downloadFile).toHaveBeenCalled();
        expect(runClaudeTask).toHaveBeenCalled();
      });
    });
  });

  // --- template card event processing ---

  describe('template card event processing', () => {
    it('should handle stop button click with running task', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      // First, create a running task via text message
      const mockSettle = vi.fn();
      const mockAbort = vi.fn();

      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        adapter.onTaskReady({
          handle: { abort: mockAbort } as any,
          settle: mockSettle,
          startedAt: Date.now(),
          latestContent: '任务内容',
        });
      });

      const textFrame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-t1' },
        body: {
          msgid: 'msg-task-1',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'text',
          text: { content: '运行任务' },
        },
      };
      mockClient.emit('message.text', textFrame);

      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalled();
      });

      // Get the task key used by the handler
      const callArgs = vi.mocked(runClaudeTask).mock.calls[0];
      const taskCtx = callArgs[1];
      const taskKey = taskCtx.taskKey;

      // Now emit stop event
      const eventFrame = {
        cmd: 'aibot_event_callback',
        headers: { req_id: 'req-e1' },
        body: {
          msgid: 'evt-1',
          create_time: Date.now(),
          aibotid: 'bot-1',
          from: { userid: 'user1' },
          msgtype: 'event',
          event: {
            eventtype: 'template_card_event',
            event_key: `stop_${taskKey}`,
            task_id: `stop_${taskKey}`,
          },
        },
      };
      mockClient.emit('event.template_card_event', eventFrame);

      await vi.waitFor(() => {
        expect(mockSettle).toHaveBeenCalled();
        expect(mockAbort).toHaveBeenCalled();
        expect(mockClient.updateTemplateCard).toHaveBeenCalledWith(
          eventFrame,
          expect.objectContaining({
            sub_title_text: '⏹️ 已停止',
          }),
        );
      });
    });

    it('should handle permission allow button click', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      vi.mocked(resolvePermissionById).mockReturnValueOnce('perm-123');

      const frame = {
        cmd: 'aibot_event_callback',
        headers: { req_id: 'req-p1' },
        body: {
          msgid: 'evt-perm-1',
          create_time: Date.now(),
          aibotid: 'bot-1',
          from: { userid: 'user1' },
          msgtype: 'event',
          event: {
            eventtype: 'template_card_event',
            event_key: 'perm_allow_perm-123',
            task_id: 'perm_perm-123',
          },
        },
      };
      mockClient.emit('event.template_card_event', frame);

      await vi.waitFor(() => {
        expect(resolvePermissionById).toHaveBeenCalledWith('perm-123', 'allow');
        expect(mockClient.updateTemplateCard).toHaveBeenCalledWith(
          frame,
          expect.objectContaining({
            main_title: { title: '✅ 已允许' },
          }),
        );
      });
    });

    it('should handle permission deny button click', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      vi.mocked(resolvePermissionById).mockReturnValueOnce('perm-456');

      const frame = {
        cmd: 'aibot_event_callback',
        headers: { req_id: 'req-p2' },
        body: {
          msgid: 'evt-perm-2',
          create_time: Date.now(),
          aibotid: 'bot-1',
          from: { userid: 'user1' },
          msgtype: 'event',
          event: {
            eventtype: 'template_card_event',
            event_key: 'perm_deny_perm-456',
            task_id: 'perm_perm-456',
          },
        },
      };
      mockClient.emit('event.template_card_event', frame);

      await vi.waitFor(() => {
        expect(resolvePermissionById).toHaveBeenCalledWith('perm-456', 'deny');
        expect(mockClient.updateTemplateCard).toHaveBeenCalledWith(
          frame,
          expect.objectContaining({
            main_title: { title: '❌ 已拒绝' },
          }),
        );
      });
    });

    it('should handle expired permission request', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      vi.mocked(resolvePermissionById).mockReturnValueOnce(null);

      const frame = {
        cmd: 'aibot_event_callback',
        headers: { req_id: 'req-p3' },
        body: {
          msgid: 'evt-perm-3',
          create_time: Date.now(),
          aibotid: 'bot-1',
          from: { userid: 'user1' },
          msgtype: 'event',
          event: {
            eventtype: 'template_card_event',
            event_key: 'perm_allow_expired-123',
            task_id: 'perm_expired-123',
          },
        },
      };
      mockClient.emit('event.template_card_event', frame);

      await vi.waitFor(() => {
        expect(mockClient.updateTemplateCard).toHaveBeenCalledWith(
          frame,
          expect.objectContaining({
            main_title: { title: '请求已过期' },
          }),
        );
      });
    });
  });

  // --- handleClaudeRequest internals ---

  describe('handleClaudeRequest adapter', () => {
    it('runClaudeTask should receive correct parameters', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-a1' },
        body: {
          msgid: 'msg-adapter-1',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'text',
          text: { content: '分析代码' },
        },
      };
      mockClient.emit('message.text', frame);

      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.anything(),
            sessionManager: expect.anything(),
            userCosts: expect.any(Map),
          }),
          expect.objectContaining({
            userId: 'user1',
            chatId: 'user1',
            workDir: '/work',
            platform: 'wecom',
          }),
          '分析代码',
          expect.objectContaining({
            throttleMs: 200,
            streamUpdate: expect.any(Function),
            sendComplete: expect.any(Function),
            sendError: expect.any(Function),
            onThinkingToText: expect.any(Function),
            extraCleanup: expect.any(Function),
            onTaskReady: expect.any(Function),
          }),
        );
      });
    });

    it('adapter.streamUpdate should call sender.sendStreamUpdate', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-a2' },
        body: {
          msgid: 'msg-adapter-2',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'text',
          text: { content: '流式测试' },
        },
      };
      mockClient.emit('message.text', frame);

      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalled();
      });

      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      capturedAdapter.streamUpdate('部分内容', '工具提示');
      // sendStreamUpdate is async but called with .catch(() => {})
      expect(senderInstance.sendStreamUpdate).toHaveBeenCalledWith('部分内容', '工具提示');
    });

    it('adapter.sendComplete should call sender.sendStreamComplete', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-a3' },
        body: {
          msgid: 'msg-adapter-3',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'text',
          text: { content: '完成测试' },
        },
      };
      mockClient.emit('message.text', frame);

      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalled();
      });

      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await capturedAdapter.sendComplete('最终内容', '完成备注');
      expect(senderInstance.sendStreamComplete).toHaveBeenCalledWith('最终内容', '完成备注');
    });

    it('adapter.sendError should call sender.sendStreamError', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-a4' },
        body: {
          msgid: 'msg-adapter-4',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'text',
          text: { content: '错误测试' },
        },
      };
      mockClient.emit('message.text', frame);

      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalled();
      });

      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      await capturedAdapter.sendError('超时');
      expect(senderInstance.sendStreamError).toHaveBeenCalledWith('超时');
    });

    it('adapter.extraCleanup should clean up stream and remove task', async () => {
      setupWecomHandlers(mockClient as any, mockConfig as any, mockSessionManager as any);

      let capturedAdapter: any;
      vi.mocked(runClaudeTask).mockImplementationOnce(async (_deps, _ctx, _prompt, adapter) => {
        capturedAdapter = adapter;
      });

      const frame = {
        cmd: 'aibot_msg_callback',
        headers: { req_id: 'req-a5' },
        body: {
          msgid: 'msg-adapter-5',
          chattype: 'single',
          from: { userid: 'user1' },
          msgtype: 'text',
          text: { content: '清理测试' },
        },
      };
      mockClient.emit('message.text', frame);

      await vi.waitFor(() => {
        expect(runClaudeTask).toHaveBeenCalled();
      });

      const senderInstance = vi.mocked(createWecomSender).mock.results[0]?.value;
      capturedAdapter.extraCleanup();
      expect(senderInstance.cleanupStream).toHaveBeenCalled();
    });
  });
});
