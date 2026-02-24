import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn(), existsSync: vi.fn() };
});

const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

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
});
