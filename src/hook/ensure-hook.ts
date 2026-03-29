import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('Hook');

const CLAUDE_SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');
const HOOK_MATCHER = 'Bash|Write|Edit';
const WATCH_EVENTS = ['PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'];

type HookEntry = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

/**
 * 获取 hook-script.js 的绝对路径。
 * 无论从 src/ 还是 dist/ 运行，始终返回 dist/hook/hook-script.js
 */
function getHookScriptPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // thisFile = <project>/(dist|src)/hook/ensure-hook.(js|ts)
  const projectRoot = dirname(dirname(dirname(thisFile)));
  return join(projectRoot, 'dist', 'hook', 'hook-script.js');
}

/**
 * 获取 watch-script.js 的绝对路径。
 */
function getWatchScriptPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = dirname(dirname(dirname(thisFile)));
  return join(projectRoot, 'dist', 'hook', 'watch-script.js');
}

/** 判断一个 hook command 是否指向本项目的 hook-script.js */
function isOurHook(command: string | undefined, projectHookPath: string): boolean {
  if (!command) return false;
  // 精确匹配，或者同项目下的 src/ 版本（dev 模式残留）
  if (command === projectHookPath) return true;
  const srcVariant = projectHookPath.replace('/dist/hook/', '/src/hook/');
  return command === srcVariant;
}

/**
 * 确保 Claude CLI 的 PreToolUse hook 已配置。
 * 如果 ~/.claude/settings.json 中缺少对应 hook，自动写入。
 * 如果存在指向 src/ 的旧条目，自动修正为 dist/。
 */
export function ensureHookConfigured(): boolean {
  const hookScriptPath = getHookScriptPath();

  if (!existsSync(hookScriptPath)) {
    log.warn(`Hook script not found at ${hookScriptPath}, run "pnpm build" first`);
    return false;
  }

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
  } catch {
    settings = {};
  }

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const preToolUse = (hooks.PreToolUse ?? []) as HookEntry[];

  // 查找已有的本项目 hook 条目
  let found = false;
  let needsWrite = false;

  for (const entry of preToolUse) {
    for (const h of entry.hooks ?? []) {
      if (!isOurHook(h.command, hookScriptPath)) continue;
      found = true;
      if (h.command !== hookScriptPath) {
        // 修正路径（src/ → dist/）
        log.info(`Fixing hook path: ${h.command} → ${hookScriptPath}`);
        h.command = hookScriptPath;
        needsWrite = true;
      }
    }
  }

  if (found && !needsWrite) {
    log.info('PreToolUse hook already configured');
    return true;
  }

  if (!found) {
    preToolUse.push({
      matcher: HOOK_MATCHER,
      hooks: [{ type: 'command', command: hookScriptPath }],
    });
    needsWrite = true;
  }

  hooks.PreToolUse = preToolUse;

  // Watch hook 注册（PostToolUse, Stop, SubagentStart, SubagentStop）
  const watchScriptPath = getWatchScriptPath();
  if (existsSync(watchScriptPath)) {
    for (const eventName of WATCH_EVENTS) {
      const eventHooks = (hooks[eventName] ?? []) as HookEntry[];
      const hasOurHook = eventHooks.some(entry =>
        entry.hooks?.some(h => isOurHook(h.command, watchScriptPath))
      );
      if (!hasOurHook) {
        eventHooks.push({
          matcher: '',
          hooks: [{ type: 'command', command: watchScriptPath }],
        });
        hooks[eventName] = eventHooks;
        needsWrite = true;
      }
    }
  }

  settings.hooks = hooks;

  try {
    mkdirSync(dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
    writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    log.info(`PreToolUse hook auto-configured → ${hookScriptPath}`);
    return true;
  } catch (err) {
    log.error(`Failed to write hook config to ${CLAUDE_SETTINGS_PATH}:`, err);
    return false;
  }
}
