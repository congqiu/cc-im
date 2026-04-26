import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/hook/permission-server.js', () => ({
  resolveLatestPermission: vi.fn(),
  getPendingCount: vi.fn(() => 0),
}));

vi.mock('../../../src/constants.js', () => ({
  APP_HOME: '/tmp/cc-im-test',
  TERMINAL_ONLY_COMMANDS: new Set([
    '/context', '/rewind', '/copy', '/export',
    '/config', '/init', '/memory', '/permissions', '/theme',
    '/vim', '/statusline', '/terminal-setup', '/debug',
    '/tasks', '/mcp', '/teleport', '/add-dir',
  ]),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{}'),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async () => []),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_path: string, _args: string[], _opts: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(null, 'v1.0.0', '');
  }),
}));

vi.mock('../../../src/shared/history.js', () => ({
  getHistory: vi.fn(),
  formatHistoryPage: vi.fn(() => 'formatted history'),
  getSessionList: vi.fn(),
  formatSessionList: vi.fn(() => 'mock session list'),
}));

// Import after mocks
import { CommandHandler } from '../../../src/commands/handler.js';
import type { CommandHandlerDeps, ClaudeRequestHandler, MessageSender } from '../../../src/commands/handler.js';
import type { Config } from '../../../src/config.js';
import type { CostRecord, ThreadContext } from '../../../src/shared/types.js';
import { resolveLatestPermission, getPendingCount } from '../../../src/hook/permission-server.js';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { getHistory, getSessionList, formatSessionList } from '../../../src/shared/history.js';
import { clearAllWatches } from '../../../src/hook/watch.js';

// ─── Helper factories ───

function createMockConfig(overrides?: Partial<Config>): Config {
  return {
    enabledPlatforms: ['feishu'],
    agentProvider: 'claude',
    agentCliPath: '/usr/bin/claude',
    agentModel: 'sonnet',
    agentSkipPermissions: false,
    agentTimeoutMs: 300000,
    feishuAppId: 'test-app-id',
    feishuAppSecret: 'test-secret',
    telegramBotToken: '',
    allowedUserIds: [],
    claudeCliPath: '/usr/bin/claude',
    claudeWorkDir: '/work',
    allowedBaseDirs: ['/work'],
    codexCliPath: '/usr/bin/codex',
    codexSandbox: 'workspace-write',
    codexApprovalPolicy: 'on-request',
    opencodeCliPath: '/usr/bin/opencode',
    wecomBotId: '',
    wecomBotSecret: '',
    hookPort: 18900,
    logDir: '/tmp/logs',
    logLevel: 'DEBUG',
    ...overrides,
  };
}

function createMockSessionManager() {
  return {
    getSessionId: vi.fn(),
    setSessionId: vi.fn(),
    getConvId: vi.fn(() => 'conv-123'),
    getWorkDir: vi.fn(() => '/work'),
    setWorkDir: vi.fn(async () => '/work/subdir'),
    newSession: vi.fn(() => true),
    getSessionIdForConv: vi.fn(() => 'session-abc'),
    setSessionIdForConv: vi.fn(),
    getWorkDirForThread: vi.fn(() => '/work/thread'),
    setWorkDirForThread: vi.fn(async () => '/work/thread/sub'),
    getSessionIdForThread: vi.fn(() => 'thread-session-abc'),
    setSessionIdForThread: vi.fn(),
    newThreadSession: vi.fn(() => true),
    getModel: vi.fn(() => undefined),
    setModel: vi.fn(),
    listThreads: vi.fn(() => []),
    getThreadSession: vi.fn(),
    setThreadSession: vi.fn(),
    resumeSession: vi.fn(() => true),
    addTurns: vi.fn(),
    addTurnsForThread: vi.fn(),
  };
}

function createMockSender(): MessageSender {
  return {
    sendTextReply: vi.fn(async () => {}),
  };
}

function createMockRequestQueue() {
  return {
    enqueue: vi.fn((_userId: string, _convId: string, prompt: string, execute: (p: string) => void) => {
      execute(prompt);
      return { status: 'running' };
    }),
  };
}

function createDeps(overrides?: Partial<CommandHandlerDeps>): CommandHandlerDeps {
  return {
    config: createMockConfig(),
    sessionManager: createMockSessionManager() as any,
    requestQueue: createMockRequestQueue() as any,
    sender: createMockSender(),
    userCosts: new Map<string, CostRecord>(),
    getRunningTasksSize: () => 0,
    ...overrides,
  };
}

const CHAT_ID = 'chat-123';
const USER_ID = 'user-456';
const THREAD_CTX: ThreadContext = { rootMessageId: 'om_root', threadId: 'omt_thread' };

describe('CommandHandler', () => {
  let deps: CommandHandlerDeps;
  let handler: CommandHandler;
  let mockHandleClaudeRequest: ClaudeRequestHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllWatches();
    // Restore execFile default mock (may have been overridden by individual tests)
    vi.mocked(execFile as any).mockImplementation((_p: any, _a: any, _o: any, cb: any) => {
      cb(null, 'v1.0.0', '');
    });
    deps = createDeps();
    handler = new CommandHandler(deps);
    mockHandleClaudeRequest = vi.fn(async () => {});
  });

  // ─── dispatch() routing ───

  describe('dispatch() - command routing', () => {
    it('should route /help to handleHelp and return true', async () => {
      const result = await handler.dispatch('/help', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('可用命令'),
        undefined,
      );
    });

    it('should route /new to handleNew and return true', async () => {
      const result = await handler.dispatch('/new', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
      expect(deps.sender.sendTextReply).toHaveBeenCalled();
    });

    it('should route /pwd to handlePwd and return true', async () => {
      const result = await handler.dispatch('/pwd', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /cd to handleCd and return true', async () => {
      const result = await handler.dispatch('/cd /some/dir', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /cd without args', async () => {
      const result = await handler.dispatch('/cd', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /model to handleModel and return true', async () => {
      const result = await handler.dispatch('/model', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /model with args', async () => {
      const result = await handler.dispatch('/model opus', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /cost to handleCost and return true', async () => {
      const result = await handler.dispatch('/cost', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /status to handleStatus and return true', async () => {
      const result = await handler.dispatch('/status', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /doctor to handleDoctor and return true', async () => {
      const result = await handler.dispatch('/doctor', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /list to handleList and return true', async () => {
      const result = await handler.dispatch('/list', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /compact to handleCompact and return true', async () => {
      const result = await handler.dispatch('/compact', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /compact with args', async () => {
      const result = await handler.dispatch('/compact focus on auth', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /history to handleHistory and return true', async () => {
      vi.mocked(getHistory).mockResolvedValue({ ok: false, error: 'no history' });
      const result = await handler.dispatch('/history', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /history with page number', async () => {
      vi.mocked(getHistory).mockResolvedValue({ ok: false, error: 'no history' });
      const result = await handler.dispatch('/history 2', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /watch to handleWatch and return true', async () => {
      const result = await handler.dispatch('/watch', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /watch with args', async () => {
      const result = await handler.dispatch('/watch tool', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /allow to handleAllow and return true', async () => {
      const result = await handler.dispatch('/allow', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /y to handleAllow and return true', async () => {
      const result = await handler.dispatch('/y', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /deny to handleDeny and return true', async () => {
      const result = await handler.dispatch('/deny', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should route /n to handleDeny and return true', async () => {
      const result = await handler.dispatch('/n', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should return false for non-command text', async () => {
      const result = await handler.dispatch('hello world', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(false);
    });

    it('should return false for unknown commands', async () => {
      const result = await handler.dispatch('/unknown', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(false);
    });

    it('should trim whitespace before matching', async () => {
      const result = await handler.dispatch('  /help  ', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
      expect(deps.sender.sendTextReply).toHaveBeenCalled();
    });
  });

  // ─── Platform-specific commands ───

  describe('dispatch() - platform-specific commands', () => {
    it('should handle /start on telegram', async () => {
      const result = await handler.dispatch('/start', CHAT_ID, USER_ID, 'telegram', mockHandleClaudeRequest);
      expect(result).toBe(true);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('欢迎使用 Claude Code Bot'),
      );
    });

    it('should NOT handle /start on feishu (returns false)', async () => {
      const result = await handler.dispatch('/start', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(false);
    });

    it('should handle /threads on feishu', async () => {
      const result = await handler.dispatch('/threads', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should NOT handle /threads on telegram (returns false)', async () => {
      const result = await handler.dispatch('/threads', CHAT_ID, USER_ID, 'telegram', mockHandleClaudeRequest);
      expect(result).toBe(false);
    });
  });

  // ─── Terminal-only commands ───

  describe('dispatch() - terminal-only commands', () => {
    it('should intercept terminal-only commands and show message', async () => {
      const result = await handler.dispatch('/config', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('仅在终端交互模式下可用'),
        undefined,
      );
    });

    it('should intercept /mcp as terminal-only', async () => {
      const result = await handler.dispatch('/mcp', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('/mcp'),
        undefined,
      );
    });

    it('should intercept /init as terminal-only', async () => {
      const result = await handler.dispatch('/init', CHAT_ID, USER_ID, 'telegram', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });
  });

  // ─── /help ───

  describe('handleHelp', () => {
    it('should return help text with feishu-specific commands', async () => {
      await handler.dispatch('/help', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('/threads');
      expect(text).not.toContain('/start');
    });

    it('should return help text with telegram-specific commands', async () => {
      await handler.dispatch('/help', CHAT_ID, USER_ID, 'telegram', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('/start');
      expect(text).not.toContain('/threads');
    });

    it('should include group headings', async () => {
      await handler.dispatch('/help', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('会话管理');
      expect(text).toContain('工作区');
      expect(text).toContain('监控与诊断');
      expect(text).toContain('高级');
    });

    it('should include common commands', async () => {
      await handler.dispatch('/help', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('/new');
      expect(text).toContain('/cd');
      expect(text).toContain('/pwd');
      expect(text).toContain('/model');
      expect(text).toContain('/cost');
      expect(text).toContain('/status');
      expect(text).toContain('/compact');
      expect(text).toContain('/history');
      expect(text).toContain('/watch');
      expect(text).toContain('/allow');
      expect(text).toContain('/deny');
    });
  });

  // ─── /new ───

  describe('handleNew', () => {
    it('should call newSession and send success message', async () => {
      await handler.dispatch('/new', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.newSession).toHaveBeenCalledWith(USER_ID);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('已开始新会话'),
        undefined,
      );
    });

    it('should send "no active session" when newSession returns false', async () => {
      vi.mocked(deps.sessionManager.newSession).mockReturnValue(false);
      await handler.dispatch('/new', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '当前没有活动会话。',
        undefined,
      );
    });

    it('should call newThreadSession when threadCtx is provided', async () => {
      await handler.dispatch('/new', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest, THREAD_CTX);
      expect(deps.sessionManager.newThreadSession).toHaveBeenCalledWith(USER_ID, THREAD_CTX.threadId);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('已开始新会话'),
        THREAD_CTX,
      );
    });

    it('should send "no active session" when newThreadSession returns false', async () => {
      vi.mocked(deps.sessionManager.newThreadSession).mockReturnValue(false);
      await handler.dispatch('/new', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest, THREAD_CTX);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '当前话题没有活动会话。',
        THREAD_CTX,
      );
    });
  });

  // ─── /cd ───

  describe('handleCd', () => {
    it('should call setWorkDir and send success message', async () => {
      await handler.dispatch('/cd /work/subdir', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setWorkDir).toHaveBeenCalledWith(USER_ID, '/work/subdir');
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('工作目录已切换到'),
        undefined,
      );
    });

    it('should send error message when setWorkDir throws', async () => {
      vi.mocked(deps.sessionManager.setWorkDir).mockRejectedValue(new Error('目录不在允许范围内'));
      await handler.dispatch('/cd /forbidden', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '❌ 目录切换失败: 目录不在允许范围内',
        undefined,
      );
    });

    it('should show current dir and subdirs when no arg provided', async () => {
      vi.mocked(readdir as any).mockResolvedValue([
        { name: 'src', isDirectory: () => true },
        { name: 'tests', isDirectory: () => true },
        { name: '.git', isDirectory: () => true },
        { name: 'README.md', isDirectory: () => false },
      ]);
      await handler.dispatch('/cd', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('当前工作目录');
      expect(text).toContain('src/');
      expect(text).toContain('tests/');
      // Hidden dirs should be excluded
      expect(text).not.toContain('.git');
    });

    it('should use thread workDir when threadCtx is provided', async () => {
      await handler.dispatch('/cd /work/thread/sub', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest, THREAD_CTX);
      expect(deps.sessionManager.setWorkDirForThread).toHaveBeenCalledWith(
        USER_ID, THREAD_CTX.threadId, '/work/thread/sub', THREAD_CTX.rootMessageId,
      );
    });

    it('should handle non-Error exceptions gracefully', async () => {
      vi.mocked(deps.sessionManager.setWorkDir).mockRejectedValue('string error');
      await handler.dispatch('/cd /bad', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '❌ 目录切换失败: string error',
        undefined,
      );
    });

    it('should switch workDir by index from /list', async () => {
      vi.mocked(readFileSync as any).mockReturnValue(JSON.stringify({
        projects: { '/work': {}, '/work/alpha': {}, '/work/beta': {} },
      }));
      await handler.dispatch('/cd 2', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      // sorted: /work, /work/alpha, /work/beta → index 2 = /work/alpha
      expect(deps.sessionManager.setWorkDir).toHaveBeenCalledWith(USER_ID, '/work/alpha');
    });

    it('should reject out-of-range index', async () => {
      vi.mocked(readFileSync as any).mockReturnValue(JSON.stringify({
        projects: { '/work': {} },
      }));
      await handler.dispatch('/cd 99', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('无效的序号'),
        undefined,
      );
      expect(deps.sessionManager.setWorkDir).not.toHaveBeenCalled();
    });

    it('should reject index 0 (1-based numbering)', async () => {
      vi.mocked(readFileSync as any).mockReturnValue(JSON.stringify({
        projects: { '/work': {} },
      }));
      await handler.dispatch('/cd 0', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('无效的序号'),
        undefined,
      );
    });
  });

  // ─── /pwd ───

  describe('handlePwd', () => {
    it('should return current work dir', async () => {
      await handler.dispatch('/pwd', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '当前工作目录: /work',
        undefined,
      );
    });

    it('should use thread workDir when threadCtx is provided', async () => {
      await handler.dispatch('/pwd', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest, THREAD_CTX);
      expect(deps.sessionManager.getWorkDirForThread).toHaveBeenCalledWith(USER_ID, THREAD_CTX.threadId);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '当前工作目录: /work/thread',
        THREAD_CTX,
      );
    });
  });

  // ─── /model ───

  describe('handleModel', () => {
    it('should show current model when no arg (no user model set, no global default)', async () => {
      vi.mocked(deps.sessionManager.getModel).mockReturnValue(undefined);
      deps.config.agentModel = undefined;
      await handler.dispatch('/model', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('当前模型');
      expect(text).toContain('默认 (由 Claude Code 决定)');
    });

    it('should show user model when user has set one', async () => {
      vi.mocked(deps.sessionManager.getModel).mockReturnValue('sonnet');
      await handler.dispatch('/model', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('当前模型: sonnet');
    });

    it('should show global agentModel as fallback when no user model set', async () => {
      vi.mocked(deps.sessionManager.getModel).mockReturnValue(undefined);
      deps.config.agentModel = 'opus';
      await handler.dispatch('/model', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('当前模型: opus');
    });

    it('should call sessionManager.setModel when valid model name provided', async () => {
      await handler.dispatch('/model sonnet', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).toHaveBeenCalledWith(USER_ID, 'sonnet', undefined);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('模型已切换为: sonnet'),
        undefined,
      );
    });

    it('should accept model names with dots, hyphens, and slashes', async () => {
      await handler.dispatch('/model claude-3.5-sonnet', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).toHaveBeenCalledWith(USER_ID, 'claude-3.5-sonnet', undefined);
    });

    it('should accept model names with slashes like anthropic/claude-3.5', async () => {
      await handler.dispatch('/model anthropic/claude-3.5', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).toHaveBeenCalledWith(USER_ID, 'anthropic/claude-3.5', undefined);
    });

    it('should reject invalid model name with special characters', async () => {
      await handler.dispatch('/model bad$model', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).not.toHaveBeenCalled();
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('无效的模型名称'),
        undefined,
      );
    });

    it('should reject model name with consecutive slashes', async () => {
      await handler.dispatch('/model bad//model', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).not.toHaveBeenCalled();
    });

    it('should reject model name starting with slash', async () => {
      await handler.dispatch('/model /badmodel', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).not.toHaveBeenCalled();
    });

    it('should reject model name ending with slash', async () => {
      await handler.dispatch('/model badmodel/', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).not.toHaveBeenCalled();
    });

    it('should reject model name exceeding 100 chars', async () => {
      const longName = 'a'.repeat(101);
      await handler.dispatch(`/model ${longName}`, CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sessionManager.setModel).not.toHaveBeenCalled();
    });
  });

  // ─── /cost ───

  describe('handleCost', () => {
    it('should show empty message when no cost record', async () => {
      await handler.dispatch('/cost', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('暂无费用记录'),
        undefined,
      );
    });

    it('should show empty message when requestCount is 0', async () => {
      deps.userCosts.set(USER_ID, { totalCost: 0, totalDurationMs: 0, requestCount: 0 });
      await handler.dispatch('/cost', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('暂无费用记录'),
        undefined,
      );
    });

    it('should show cost info when records exist', async () => {
      deps.userCosts.set(USER_ID, { totalCost: 1.2345, totalDurationMs: 10000, requestCount: 3 });
      await handler.dispatch('/cost', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('费用统计');
      expect(text).toContain('请求次数: 3');
      expect(text).toContain('$1.2345');
      expect(text).toContain('10.0s');
    });
  });

  // ─── /status ───

  describe('handleStatus', () => {
    it('should return status info including version and workDir', async () => {
      await handler.dispatch('/status', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('Claude Code 状态');
      expect(text).toContain('v1.0.0');
      expect(text).toContain('/work');
      expect(text).toContain('session-abc');
      expect(text).toContain('300');
    });

    it('should show "unknown" version when execFile fails', async () => {
      vi.mocked(execFile as any).mockImplementation((_p: any, _a: any, _o: any, cb: any) => {
        cb(new Error('not found'), '', '');
      });
      await handler.dispatch('/status', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('未知');
    });

    it('should show session ID as "none" when no session', async () => {
      vi.mocked(deps.sessionManager.getSessionIdForConv).mockReturnValue(undefined);
      await handler.dispatch('/status', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('（无）');
    });

    it('should use thread session when threadCtx provided', async () => {
      await handler.dispatch('/status', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest, THREAD_CTX);
      expect(deps.sessionManager.getWorkDirForThread).toHaveBeenCalledWith(USER_ID, THREAD_CTX.threadId);
      expect(deps.sessionManager.getSessionIdForThread).toHaveBeenCalledWith(USER_ID, THREAD_CTX.threadId);
    });
  });

  // ─── /doctor ───

  describe('handleDoctor', () => {
    it('should return health check info', async () => {
      await handler.dispatch('/doctor', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('健康检查');
      expect(text).toContain('/usr/bin/claude');
      expect(text).toContain('v1.0.0');
      expect(text).toContain('/work');
    });

    it('should show running tasks count', async () => {
      deps.getRunningTasksSize = () => 5;
      await handler.dispatch('/doctor', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('5');
    });
  });

  // ─── /allow, /deny ───

  describe('handleAllow', () => {
    it('should resolve permission and send success message', async () => {
      vi.mocked(resolveLatestPermission).mockReturnValue('req-123');
      vi.mocked(getPendingCount).mockReturnValue(0);
      await handler.dispatch('/allow', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(resolveLatestPermission).toHaveBeenCalledWith(CHAT_ID, 'allow');
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('权限已允许'),
        undefined,
      );
    });

    it('should show remaining count after allow', async () => {
      vi.mocked(resolveLatestPermission).mockReturnValue('req-123');
      vi.mocked(getPendingCount).mockReturnValue(2);
      await handler.dispatch('/allow', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('还有 2 个待确认');
    });

    it('should show no pending message when nothing to allow', async () => {
      vi.mocked(resolveLatestPermission).mockReturnValue(null);
      await handler.dispatch('/allow', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('没有待确认的权限请求'),
        undefined,
      );
    });

    it('should work with /y alias', async () => {
      vi.mocked(resolveLatestPermission).mockReturnValue('req-123');
      vi.mocked(getPendingCount).mockReturnValue(0);
      await handler.dispatch('/y', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(resolveLatestPermission).toHaveBeenCalledWith(CHAT_ID, 'allow');
    });
  });

  describe('handleDeny', () => {
    it('should resolve permission with deny and send message', async () => {
      vi.mocked(resolveLatestPermission).mockReturnValue('req-456');
      vi.mocked(getPendingCount).mockReturnValue(0);
      await handler.dispatch('/deny', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(resolveLatestPermission).toHaveBeenCalledWith(CHAT_ID, 'deny');
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('权限已拒绝'),
        undefined,
      );
    });

    it('should show remaining count after deny', async () => {
      vi.mocked(resolveLatestPermission).mockReturnValue('req-456');
      vi.mocked(getPendingCount).mockReturnValue(1);
      await handler.dispatch('/deny', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('还有 1 个待确认');
    });

    it('should work with /n alias', async () => {
      vi.mocked(resolveLatestPermission).mockReturnValue('req-456');
      vi.mocked(getPendingCount).mockReturnValue(0);
      await handler.dispatch('/n', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(resolveLatestPermission).toHaveBeenCalledWith(CHAT_ID, 'deny');
    });
  });

  // ─── /compact ───

  describe('handleCompact', () => {
    it('should send "no active session" when no sessionId', async () => {
      vi.mocked(deps.sessionManager.getSessionIdForConv).mockReturnValue(undefined);
      await handler.dispatch('/compact', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '当前没有活动会话，无需压缩。',
        undefined,
      );
    });

    it('should enqueue compact request when session exists', async () => {
      vi.mocked(deps.sessionManager.getSessionIdForConv).mockReturnValue('session-abc');
      await handler.dispatch('/compact', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.requestQueue.enqueue).toHaveBeenCalledWith(
        USER_ID,
        'conv-123',
        expect.stringContaining('压缩并总结'),
        expect.any(Function),
      );
    });

    it('should include custom instructions in compact prompt', async () => {
      vi.mocked(deps.sessionManager.getSessionIdForConv).mockReturnValue('session-abc');
      await handler.dispatch('/compact focus on auth', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.requestQueue.enqueue).toHaveBeenCalledWith(
        USER_ID,
        'conv-123',
        expect.stringContaining('focus on auth'),
        expect.any(Function),
      );
    });

    it('should show queue full message when rejected', async () => {
      vi.mocked(deps.sessionManager.getSessionIdForConv).mockReturnValue('session-abc');
      vi.mocked(deps.requestQueue.enqueue).mockReturnValue({ status: 'rejected', queueSize: 3 });
      await handler.dispatch('/compact', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('请求队列已满'),
        undefined,
      );
    });

    it('should show queued message when queued', async () => {
      vi.mocked(deps.sessionManager.getSessionIdForConv).mockReturnValue('session-abc');
      vi.mocked(deps.requestQueue.enqueue).mockReturnValue({ status: 'queued', position: 1, queueSize: 3 });
      await handler.dispatch('/compact', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('压缩请求已排队'),
        undefined,
      );
    });

    it('should use thread context for compact', async () => {
      vi.mocked(deps.sessionManager.getSessionIdForThread).mockReturnValue('thread-session');
      await handler.dispatch('/compact', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest, THREAD_CTX);
      expect(deps.requestQueue.enqueue).toHaveBeenCalledWith(
        USER_ID,
        THREAD_CTX.threadId,
        expect.any(String),
        expect.any(Function),
      );
    });
  });

  // ─── /list ───

  describe('handleList', () => {
    it('should show "no projects" when no agent projects found', async () => {
      vi.mocked(readFileSync as any).mockReturnValue('{}');
      await handler.dispatch('/list', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('未找到 Claude Code 工作区记录'),
        undefined,
      );
    });

    it('should list projects within allowed dirs', async () => {
      vi.mocked(readFileSync as any).mockReturnValue(JSON.stringify({
        projects: {
          '/work': {},
          '/work/subdir': {},
          '/other': {},
        },
      }));
      await handler.dispatch('/list', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('/work');
      expect(text).toContain('/work/subdir');
      expect(text).not.toContain('/other');
    });

    it('should mark current workdir with arrow', async () => {
      vi.mocked(readFileSync as any).mockReturnValue(JSON.stringify({
        projects: {
          '/work': {},
          '/work/subdir': {},
        },
      }));
      await handler.dispatch('/list', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      // Current dir '/work' should be marked
      expect(text).toMatch(/\d+\.\s+▶\s+\/work/);
    });

    it('should handle readFileSync error gracefully', async () => {
      vi.mocked(readFileSync as any).mockImplementation(() => { throw new Error('ENOENT'); });
      await handler.dispatch('/list', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('未找到 Claude Code 工作区记录'),
        undefined,
      );
    });
  });

  // ─── /threads ───

  describe('handleThreads', () => {
    it('should show empty message when no threads', async () => {
      vi.mocked(deps.sessionManager.listThreads).mockReturnValue([]);
      await handler.dispatch('/threads', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '暂无话题会话记录。',
        undefined,
      );
    });

    it('should list threads with session status', async () => {
      vi.mocked(deps.sessionManager.listThreads).mockReturnValue([
        { threadId: 'omt_abc12345678', sessionId: 'sess-1', workDir: '/work', rootMessageId: 'om_root1' },
        { threadId: 'omt_xyz87654321', workDir: '/work/other', rootMessageId: 'om_root2', displayName: 'My Thread' },
      ]);
      await handler.dispatch('/threads', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      const text = vi.mocked(deps.sender.sendTextReply).mock.calls[0][1];
      expect(text).toContain('话题会话列表');
      expect(text).toContain('12345678'); // last 8 chars of first threadId (no displayName)
      expect(text).toContain('My Thread');
      expect(text).toMatch(/✓/);
      expect(text).toMatch(/✗/);
    });
  });

  // ─── /history ───

  describe('handleHistory', () => {
    it('should show error when getHistory fails', async () => {
      vi.mocked(getHistory).mockResolvedValue({ ok: false, error: '未找到会话记录。' });
      await handler.dispatch('/history', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        '未找到会话记录。',
        undefined,
      );
    });

    it('should show formatted history when getHistory succeeds', async () => {
      vi.mocked(getHistory).mockResolvedValue({
        ok: true,
        data: { entries: [], page: 1, totalPages: 1, sessionId: 'sess-abc' },
      });
      await handler.dispatch('/history', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        'formatted history',
        undefined,
      );
    });

    it('should pass page number from args', async () => {
      vi.mocked(getHistory).mockResolvedValue({ ok: false, error: 'no' });
      await handler.dispatch('/history 3', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(getHistory).toHaveBeenCalledWith('/work', 'session-abc', 3, 'claude');
    });

    it('should default to page 0 (last page) when no arg', async () => {
      vi.mocked(getHistory).mockResolvedValue({ ok: false, error: 'no' });
      await handler.dispatch('/history', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(getHistory).toHaveBeenCalledWith('/work', 'session-abc', 0, 'claude');
    });

    it('should support codex history', async () => {
      deps.config = createMockConfig({ agentProvider: 'codex' });
      handler = new CommandHandler(deps);
      vi.mocked(getHistory).mockResolvedValue({ ok: false, error: 'no' });

      await handler.dispatch('/history', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);

      expect(getHistory).toHaveBeenCalledWith('/work', 'session-abc', 0, 'codex');
    });
  });

  // ─── /resume ───

  describe('handleResume', () => {
    it('should route /resume in dispatch', async () => {
      vi.mocked(getSessionList).mockResolvedValue({
        ok: true,
        data: [],
      });
      // getSessionList returns empty but ok, formatSessionList will be called
      const result = await handler.dispatch('/resume', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(result).toBe(true);
    });

    it('should show session list when no args', async () => {
      vi.mocked(getSessionList).mockResolvedValue({
        ok: true,
        data: [
          { sessionId: 'abc', mtime: Date.now(), messageCount: 5, preview: 'hello', isCurrent: true },
        ],
      });
      vi.mocked(formatSessionList).mockReturnValue('mock session list');
      await handler.dispatch('/resume', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        'mock session list',
        undefined,
      );
      expect(getSessionList).toHaveBeenCalledWith('/work', 'session-abc', 'claude');
    });

    it('should resume session by index', async () => {
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

    it('should support codex resume', async () => {
      deps.config = createMockConfig({ agentProvider: 'codex' });
      handler = new CommandHandler(deps);
      vi.mocked(getSessionList).mockResolvedValue({ ok: true, data: [] });

      await handler.dispatch('/resume', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);

      expect(getSessionList).toHaveBeenCalledWith('/work', 'session-abc', 'codex');
    });
  });

  // ─── /watch ───

  describe('handleWatch', () => {
    it('should show "未开启" when no watch active and no args', async () => {
      await handler.dispatch('/watch', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('未开启监控'),
        undefined,
      );
    });

    it('should register watch with /watch tool', async () => {
      await handler.dispatch('/watch tool', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('已开启监控 [tool]'),
        undefined,
      );
    });

    it('should show current status after registering', async () => {
      await handler.dispatch('/watch stop', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      vi.mocked(deps.sender.sendTextReply).mockClear();
      await handler.dispatch('/watch', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('监控中 [stop]'),
        undefined,
      );
    });

    it('should unregister watch with /watch off', async () => {
      // Register first
      await handler.dispatch('/watch full', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      vi.mocked(deps.sender.sendTextReply).mockClear();

      // Unregister
      await handler.dispatch('/watch off', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('已关闭监控'),
        undefined,
      );

      // Verify it's gone
      vi.mocked(deps.sender.sendTextReply).mockClear();
      await handler.dispatch('/watch', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('未开启监控'),
        undefined,
      );
    });

    it('should show error for invalid level', async () => {
      await handler.dispatch('/watch invalid', CHAT_ID, USER_ID, 'feishu', mockHandleClaudeRequest);
      expect(deps.sender.sendTextReply).toHaveBeenCalledWith(
        CHAT_ID,
        expect.stringContaining('无效的监控级别'),
        undefined,
      );
    });
  });
});
