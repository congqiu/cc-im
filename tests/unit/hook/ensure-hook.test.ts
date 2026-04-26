import { describe, it, expect, vi, beforeEach, } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: vi.fn() };
});

describe('ensureHookConfigured', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
  });

  async function loadModule() {
    return import('../../../src/hook/ensure-hook.js');
  }

  it('should add hook when settings.json has no hooks', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ model: 'opus' }));
    vi.mocked(writeFileSync).mockImplementation(() => {});

    const { ensureHookConfigured } = await loadModule();
    const result = ensureHookConfigured();

    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalledOnce();

    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(written.hooks.PreToolUse).toHaveLength(1);
    expect(written.hooks.PreToolUse[0].matcher).toBe('Bash|Write|Edit');
    expect(written.hooks.PreToolUse[0].hooks[0].command).toMatch(/dist\/hook\/hook-script\.js$/);
    // 保留原有字段
    expect(written.model).toBe('opus');
  });

  it('should skip write when hook already configured', async () => {
    const { ensureHookConfigured } = await loadModule();

    // 先获取 ensureHookConfigured 会写入的路径
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ model: 'opus' }));
    vi.mocked(writeFileSync).mockImplementation(() => {});
    ensureHookConfigured();
    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    const hookPath = written.hooks.PreToolUse[0].hooks[0].command;

    // 重置，模拟已有配置
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: hookPath }] }] },
    }));

    const result = ensureHookConfigured();
    expect(result).toBe(true);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('should fix src/ path to dist/ path', async () => {
    const { ensureHookConfigured } = await loadModule();

    // 先获取正确的 dist 路径
    vi.mocked(readFileSync).mockReturnValue('{}');
    vi.mocked(writeFileSync).mockImplementation(() => {});
    ensureHookConfigured();
    const distPath = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string)
      .hooks.PreToolUse[0].hooks[0].command as string;
    const srcPath = distPath.replace('/dist/hook/', '/src/hook/');

    // 重置，模拟 src/ 路径
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit', hooks: [{ type: 'command', command: srcPath }] }] },
    }));

    const result = ensureHookConfigured();
    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalledOnce();

    const fixed = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(fixed.hooks.PreToolUse[0].hooks[0].command).toBe(distPath);
  });

  it('should return false when hook script does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const { ensureHookConfigured } = await loadModule();
    const result = ensureHookConfigured();

    expect(result).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('should handle missing settings.json gracefully', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    vi.mocked(writeFileSync).mockImplementation(() => {});

    const { ensureHookConfigured } = await loadModule();
    const result = ensureHookConfigured();

    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalledOnce();
  });

  it('should register watch hook events when watch-script.js exists', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ model: 'opus' }));
    vi.mocked(writeFileSync).mockImplementation(() => {});
    vi.mocked(existsSync).mockReturnValue(true);

    const { ensureHookConfigured } = await loadModule();
    const result = ensureHookConfigured();

    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalledOnce();

    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    const watchEvents = ['PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'];
    for (const event of watchEvents) {
      expect(written.hooks[event]).toHaveLength(1);
      expect(written.hooks[event][0].hooks[0].command).toMatch(/dist\/hook\/watch-script\.js$/);
    }
  });

  it('should skip watch hooks when watch-script.js does not exist', async () => {
    // hook-script.js 存在，watch-script.js 不存在
    vi.mocked(existsSync).mockImplementation((p) => {
      return !String(p).includes('watch-script');
    });
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
    vi.mocked(writeFileSync).mockImplementation(() => {});

    const { ensureHookConfigured } = await loadModule();
    const result = ensureHookConfigured();

    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalledOnce();

    const written = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);
    expect(written.hooks.PreToolUse).toHaveLength(1);
    // watch 事件不应被注册
    expect(written.hooks.PostToolUse).toBeUndefined();
    expect(written.hooks.Stop).toBeUndefined();
    expect(written.hooks.SubagentStart).toBeUndefined();
    expect(written.hooks.SubagentStop).toBeUndefined();
  });

  it('should not duplicate watch hooks when already registered', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(writeFileSync).mockImplementation(() => {});

    const { ensureHookConfigured } = await loadModule();

    // First call: register everything
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
    ensureHookConfigured();
    const firstWrite = JSON.parse(vi.mocked(writeFileSync).mock.calls[0][1] as string);

    // Second call: pass the previously written config back
    vi.mocked(writeFileSync).mockClear();
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify(firstWrite));
    const result = ensureHookConfigured();

    expect(result).toBe(true);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('should configure codex hooks and enable codex_hooks feature', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path) => {
      const value = String(path);
      if (value.endsWith('/.codex/config.toml')) return 'model = "gpt-5.4"\n';
      throw new Error('ENOENT');
    });
    vi.mocked(writeFileSync).mockImplementation(() => {});

    const { ensureHookConfigured } = await loadModule();
    const result = ensureHookConfigured('codex');

    expect(result).toBe(true);
    expect(writeFileSync).toHaveBeenCalledTimes(2);

    const configWrite = vi.mocked(writeFileSync).mock.calls.find(([path]) => String(path).endsWith('/.codex/config.toml'));
    const hooksWrite = vi.mocked(writeFileSync).mock.calls.find(([path]) => String(path).endsWith('/.codex/hooks.json'));

    expect(configWrite).toBeTruthy();
    expect(String(configWrite?.[1])).toContain('codex_hooks = true');

    const writtenHooks = JSON.parse(String(hooksWrite?.[1]));
    expect(writtenHooks.hooks.PermissionRequest).toHaveLength(1);
    expect(writtenHooks.hooks.PermissionRequest[0].hooks[0].command).toMatch(/dist\/hook\/hook-script\.js$/);
    expect(writtenHooks.hooks.PostToolUse[0].hooks[0].command).toMatch(/dist\/hook\/watch-script\.js$/);
    expect(writtenHooks.hooks.Stop[0].hooks[0].command).toMatch(/dist\/hook\/watch-script\.js$/);
  });
});
