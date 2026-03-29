/**
 * Watch 监控管理模块
 *
 * 管理 watchMap（workDir -> WatchEntry[]），提供注册/注销/查询/格式化功能。
 * 用于让用户通过聊天平台实时监控终端 Claude Code 的活动。
 */

import type { ThreadContext } from '../shared/types.js';
import type { Platform } from '../config.js';

export type WatchLevel = 'stop' | 'tool' | 'full';
export type WatchEventName = 'PostToolUse' | 'Stop' | 'SubagentStart' | 'SubagentStop';

export interface WatchEntry {
  chatId: string;
  platform: Platform;
  threadCtx?: ThreadContext;
  level: WatchLevel;
  mutedSessions?: Set<string>;
}

/** 每个级别订阅的事件集合 */
const LEVEL_EVENTS: Record<WatchLevel, Set<WatchEventName>> = {
  stop: new Set(['Stop']),
  tool: new Set(['PostToolUse', 'Stop']),
  full: new Set(['PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']),
};

/** Stop 消息预览最大字符数 */
const STOP_PREVIEW_MAX_LENGTH = 200;

/** workDir -> WatchEntry[] */
const watchMap = new Map<string, WatchEntry[]>();

/**
 * 注册监控。同一 chatId+threadId 更新 level 而不重复注册。
 */
export function registerWatch(workDir: string, entry: WatchEntry): void {
  const entries = watchMap.get(workDir) ?? [];
  const threadId = entry.threadCtx?.threadId;

  const existing = entries.find(
    (e) => e.chatId === entry.chatId && e.threadCtx?.threadId === threadId,
  );

  if (existing) {
    existing.level = entry.level;
    existing.platform = entry.platform;
    existing.threadCtx = entry.threadCtx;
    // 保留已有的 mutedSessions
  } else {
    entries.push({ ...entry, mutedSessions: entry.mutedSessions ?? new Set() });
  }

  watchMap.set(workDir, entries);
}

/**
 * 注销监控。按 chatId + threadId 精确匹配移除。
 */
export function unregisterWatch(workDir: string, chatId: string, threadId?: string): boolean {
  const entries = watchMap.get(workDir);
  if (!entries) return false;

  const idx = entries.findIndex(
    (e) => e.chatId === chatId && e.threadCtx?.threadId === threadId,
  );

  if (idx === -1) return false;

  entries.splice(idx, 1);
  if (entries.length === 0) {
    watchMap.delete(workDir);
  }

  return true;
}

/**
 * 按 cwd 前缀匹配 + 可选事件级别过滤 + 可选 sessionId mute 过滤。
 *
 * 匹配规则：cwd === workDir || cwd.startsWith(workDir + '/')
 */
export function getWatchEntries(cwd: string, eventName?: WatchEventName, sessionId?: string): WatchEntry[] {
  const results: WatchEntry[] = [];

  for (const [workDir, entries] of watchMap) {
    if (cwd === workDir || cwd.startsWith(workDir + '/')) {
      for (const entry of entries) {
        if (eventName && !LEVEL_EVENTS[entry.level].has(eventName)) {
          continue;
        }
        if (sessionId && entry.mutedSessions?.size && [...entry.mutedSessions].some(s => sessionId.endsWith(s))) {
          continue;
        }
        results.push(entry);
      }
    }
  }

  return results;
}

/**
 * 查询某聊天的监控状态。返回匹配的 WatchEntry 或 undefined。
 */
export function getWatchStatus(chatId: string, threadId?: string): (WatchEntry & { workDir: string }) | undefined {
  for (const [workDir, entries] of watchMap) {
    const entry = entries.find(
      (e) => e.chatId === chatId && e.threadCtx?.threadId === threadId,
    );
    if (entry) {
      return { ...entry, workDir };
    }
  }
  return undefined;
}

/**
 * 屏蔽指定会话的通知。
 */
export function muteSession(workDir: string, chatId: string, sessionSuffix: string, threadId?: string): boolean {
  const entries = watchMap.get(workDir);
  if (!entries) return false;
  const entry = entries.find(e => e.chatId === chatId && e.threadCtx?.threadId === threadId);
  if (!entry) return false;
  if (!entry.mutedSessions) entry.mutedSessions = new Set();
  entry.mutedSessions.add(sessionSuffix);
  return true;
}

/**
 * 取消屏蔽指定会话的通知。
 */
export function unmuteSession(workDir: string, chatId: string, sessionSuffix: string, threadId?: string): boolean {
  const entries = watchMap.get(workDir);
  if (!entries) return false;
  const entry = entries.find(e => e.chatId === chatId && e.threadCtx?.threadId === threadId);
  if (!entry || !entry.mutedSessions) return false;
  return entry.mutedSessions.delete(sessionSuffix);
}

/**
 * 清空所有监控（测试用）
 */
export function clearAllWatches(): void {
  watchMap.clear();
}

/** watch-notify 数据结构 */
export interface WatchNotifyData {
  eventName: WatchEventName;
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: string;
  lastAssistantMessage?: string;
  agentType?: string;
}

/**
 * 格式化通知消息。
 *
 * - PostToolUse: `🔧 Bash: npm test` / `🔧 Write: src/index.ts`
 * - Stop: `✅ Claude 已完成\n> 前 200 字预览...`
 * - SubagentStart: `🤖 子代理启动: Explore`
 * - SubagentStop: `🤖 子代理完成: Explore`
 */
export function formatWatchNotify(data: WatchNotifyData): string {
  const sid = data.sessionId ? `[${data.sessionId.slice(-4)}] ` : '';
  switch (data.eventName) {
    case 'PostToolUse': {
      const tool = data.toolName ?? 'unknown';
      const summary = getToolSummary(tool, data.toolInput);
      return summary ? `🔧 ${sid}${tool}: ${summary}` : `🔧 ${sid}${tool}`;
    }
    case 'Stop': {
      const preview = data.lastAssistantMessage ?? '';
      if (!preview) return `✅ ${sid}Claude 已完成`;
      const truncated = preview.length > STOP_PREVIEW_MAX_LENGTH
        ? preview.slice(0, STOP_PREVIEW_MAX_LENGTH) + '...'
        : preview;
      return `✅ ${sid}Claude 已完成\n> ${truncated}`;
    }
    case 'SubagentStart':
      return `🤖 ${sid}子代理启动: ${data.agentType ?? 'unknown'}`;
    case 'SubagentStop':
      return `🤖 ${sid}子代理完成: ${data.agentType ?? 'unknown'}`;
    default:
      return `❓ ${sid}未知事件: ${data.eventName}`;
  }
}

/**
 * 提取工具参数摘要
 */
function getToolSummary(toolName: string, toolInput?: Record<string, unknown>): string {
  if (!toolInput) return '';

  switch (toolName) {
    case 'Bash':
      return truncate(String(toolInput.command ?? ''), 100);
    case 'Write':
    case 'Edit':
    case 'Read':
      return truncate(String(toolInput.file_path ?? ''), 100);
    case 'Glob':
    case 'Grep':
      return truncate(String(toolInput.pattern ?? ''), 100);
    default: {
      // 取第一个字符串类型的值作为摘要
      for (const val of Object.values(toolInput)) {
        if (typeof val === 'string' && val.length > 0) {
          return truncate(val, 100);
        }
      }
      return '';
    }
  }
}

function truncate(str: string, maxLength: number): string {
  return str.length > maxLength ? str.slice(0, maxLength) + '...' : str;
}
