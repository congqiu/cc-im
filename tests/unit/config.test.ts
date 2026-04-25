import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('dotenv/config', () => ({}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockReadFileSync = vi.fn();
const mockAccessSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('node:fs', () => ({
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  accessSync: (...args: unknown[]) => mockAccessSync(...args),
  constants: { F_OK: 0, X_OK: 1 },
}));

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

// Reset modules before each test so loadConfig() reads fresh env
beforeEach(() => {
  vi.resetModules();
  mockReadFileSync.mockReset();
  mockAccessSync.mockReset();
  mockExecFileSync.mockReset();
});

const savedEnv = { ...process.env };

afterEach(() => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

function setEnv(overrides: Record<string, string>) {
  // Clear platform-related env to start clean
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.WECOM_BOT_ID;
  delete process.env.WECOM_BOT_SECRET;
  delete process.env.ALLOWED_USER_IDS;
  delete process.env.CLAUDE_CLI_PATH;
  delete process.env.CLAUDE_WORK_DIR;
  delete process.env.ALLOWED_BASE_DIRS;
  delete process.env.CLAUDE_SKIP_PERMISSIONS;
  delete process.env.CLAUDE_TIMEOUT_MS;
  delete process.env.CLAUDE_MODEL;
  delete process.env.HOOK_SERVER_PORT;
  delete process.env.LOG_DIR;
  delete process.env.LOG_LEVEL;
  Object.assign(process.env, overrides);
}

async function loadConfigFresh() {
  const mod = await import('../../src/config.js');
  return mod.loadConfig();
}

describe('loadConfig', () => {
  it('从环境变量加载飞书配置', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      FEISHU_APP_ID: 'app123',
      FEISHU_APP_SECRET: 'secret456',
      CLAUDE_CLI_PATH: 'claude',
    });

    const config = await loadConfigFresh();
    expect(config.enabledPlatforms).toContain('feishu');
    expect(config.feishuAppId).toBe('app123');
    expect(config.feishuAppSecret).toBe('secret456');
  });

  it('从环境变量加载 Telegram 配置', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'bot-token-123',
      CLAUDE_CLI_PATH: 'claude',
    });

    const config = await loadConfigFresh();
    expect(config.enabledPlatforms).toContain('telegram');
    expect(config.telegramBotToken).toBe('bot-token-123');
  });

  it('同时启用多个平台', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      FEISHU_APP_ID: 'app',
      FEISHU_APP_SECRET: 'secret',
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
    });

    const config = await loadConfigFresh();
    expect(config.enabledPlatforms).toContain('feishu');
    expect(config.enabledPlatforms).toContain('telegram');
  });

  it('没有配置任何平台时抛出错误', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    setEnv({});

    await expect(loadConfigFresh()).rejects.toThrow('至少需要配置一个平台');
  });

  it('从配置文件加载', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      feishuAppId: 'file-app-id',
      feishuAppSecret: 'file-secret',
    }));
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({ CLAUDE_CLI_PATH: 'claude' });

    const config = await loadConfigFresh();
    expect(config.feishuAppId).toBe('file-app-id');
  });

  it('环境变量优先于配置文件', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      feishuAppId: 'file-app-id',
      feishuAppSecret: 'file-secret',
    }));
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      FEISHU_APP_ID: 'env-app-id',
      FEISHU_APP_SECRET: 'env-secret',
      CLAUDE_CLI_PATH: 'claude',
    });

    const config = await loadConfigFresh();
    expect(config.feishuAppId).toBe('env-app-id');
  });

  it('配置文件 JSON 格式错误时回退到环境变量', async () => {
    mockReadFileSync.mockReturnValue('{ invalid json }');
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
    });

    const config = await loadConfigFresh();
    expect(config.telegramBotToken).toBe('token');
  });

  it('解析 ALLOWED_USER_IDS 逗号分隔列表', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
      ALLOWED_USER_IDS: 'user1, user2, user3',
    });

    const config = await loadConfigFresh();
    expect(config.allowedUserIds).toEqual(['user1', 'user2', 'user3']);
  });

  it('CLAUDE_SKIP_PERMISSIONS 解析为布尔值', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
      CLAUDE_SKIP_PERMISSIONS: 'true',
    });

    const config = await loadConfigFresh();
    expect(config.claudeSkipPermissions).toBe(true);
  });

  it('CLAUDE_TIMEOUT_MS 解析为数字', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
      CLAUDE_TIMEOUT_MS: '300000',
    });

    const config = await loadConfigFresh();
    expect(config.claudeTimeoutMs).toBe(300000);
  });

  it('绝对路径的 Claude CLI 验证可访问性', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockAccessSync.mockImplementation(() => { throw new Error('not found'); });
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: '/usr/local/bin/claude',
    });

    await expect(loadConfigFresh()).rejects.toThrow('Claude CLI 不可访问');
  });

  it('裸命令名通过 which 验证', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
    });

    await expect(loadConfigFresh()).rejects.toThrow('Claude CLI 在 PATH 中未找到');
  });

  it('allowedBaseDirs 为空时回退到 claudeWorkDir', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
      CLAUDE_WORK_DIR: '/my/work',
    });

    const config = await loadConfigFresh();
    expect(config.allowedBaseDirs).toContain('/my/work');
  });

  it('解析 HOOK_SERVER_PORT', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
      HOOK_SERVER_PORT: '19000',
    });

    const config = await loadConfigFresh();
    expect(config.hookPort).toBe(19000);
  });

  it('配置文件读取权限错误时打印警告', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'token',
      CLAUDE_CLI_PATH: 'claude',
    });

    // Should not throw, just warn and use env
    const config = await loadConfigFresh();
    expect(config.telegramBotToken).toBe('token');
  });

  it('CLAUDE_TIMEOUT_MS 小于 10000 应使用默认值', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'test-token',
      CLAUDE_CLI_PATH: 'claude',
      CLAUDE_TIMEOUT_MS: '100',
    });
    const config = await loadConfigFresh();
    expect(config.claudeTimeoutMs).toBe(600000);
  });

  it('CLAUDE_TIMEOUT_MS 过大应使用默认值', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'test-token',
      CLAUDE_CLI_PATH: 'claude',
      CLAUDE_TIMEOUT_MS: '9999999999',
    });
    const config = await loadConfigFresh();
    expect(config.claudeTimeoutMs).toBe(600000);
  });

  it('无效的 LOG_LEVEL 应回退到 DEBUG', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      TELEGRAM_BOT_TOKEN: 'test-token',
      CLAUDE_CLI_PATH: 'claude',
      LOG_LEVEL: 'INVALID',
    });
    const config = await loadConfigFresh();
    expect(config.logLevel).toBe('DEBUG');
  });

  it('只配置了 FEISHU_APP_ID 时错误信息应包含提示', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    setEnv({
      FEISHU_APP_ID: 'app-id-test',
    });
    await expect(loadConfigFresh()).rejects.toThrow(/FEISHU_APP_SECRET/);
  });

  it('只配置了 WECOM_BOT_ID 时错误信息应包含提示', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    setEnv({
      WECOM_BOT_ID: 'bot-id-test',
    });
    await expect(loadConfigFresh()).rejects.toThrow(/WECOM_BOT_SECRET/);
  });
});

describe('wecom platform detection', () => {
  it('should detect wecom when WECOM_BOT_ID and WECOM_BOT_SECRET are set', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      WECOM_BOT_ID: 'test-bot-id',
      WECOM_BOT_SECRET: 'test-bot-secret',
      CLAUDE_CLI_PATH: 'claude',
    });
    const config = await loadConfigFresh();
    expect(config.enabledPlatforms).toContain('wecom');
    expect(config.wecomBotId).toBe('test-bot-id');
    expect(config.wecomBotSecret).toBe('test-bot-secret');
  });

  it('should not detect wecom when only WECOM_BOT_ID is set', async () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/bin/claude'));
    setEnv({
      WECOM_BOT_ID: 'test-bot-id',
      TELEGRAM_BOT_TOKEN: 'test-token',
      CLAUDE_CLI_PATH: 'claude',
    });
    const config = await loadConfigFresh();
    expect(config.enabledPlatforms).not.toContain('wecom');
  });
});
