/**
 * 共享工具函数
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CostRecord } from './types.js';
import { IMAGE_DIR } from '../constants.js';

/**
 * 工具 emoji 映射
 */
const TOOL_EMOJIS: Record<string, string> = {
  Read: '📖',
  Write: '✏️',
  Edit: '📝',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔎',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Task: '📋',
  TodoRead: '📌',
  TodoWrite: '✅',
  AskUserQuestion: '❓',
  NotebookEdit: '📓',
};

function getToolEmoji(toolName: string): string {
  return TOOL_EMOJIS[toolName] ?? '🔧';
}

/**
 * 分割长内容为多个片段
 */
export function splitLongContent(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (start + maxLen >= text.length) {
      parts.push(text.slice(start));
      break;
    }
    // Try to find a newline near the split point to avoid breaking mid-line
    let end = start + maxLen;
    const searchStart = Math.max(start, end - 200);
    const lastNewline = text.lastIndexOf('\n', end);
    if (lastNewline > searchStart) {
      end = lastNewline + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * 构建工具输入摘要（用于权限卡片）
 */
export function buildInputSummary(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash' && toolInput.command) {
    return String(toolInput.command);
  }
  if (toolName === 'Write' && toolInput.file_path) {
    return `文件: ${toolInput.file_path}\n内容长度: ${String(toolInput.content ?? '').length} 字符`;
  }
  if (toolName === 'Edit' && toolInput.file_path) {
    return `文件: ${toolInput.file_path}`;
  }
  const keys = Object.keys(toolInput);
  if (keys.length === 0) {
    return '(无参数)';
  }
  const lines = keys.slice(0, 5).map((k) => {
    const v = String(toolInput[k] ?? '');
    return `${k}: ${v.length > 200 ? v.slice(0, 200) + '...' : v}`;
  });
  return lines.join('\n');
}

/**
 * 格式化工具使用统计（用于完成 note）
 */
export function formatToolStats(toolStats: Record<string, number>, numTurns: number): string {
  const totalTools = Object.values(toolStats).reduce((sum, count) => sum + count, 0);
  if (totalTools === 0) return '';

  const parts = Object.entries(toolStats)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${getToolEmoji(name)}${name}×${count}`)
    .join(' ');

  return `${numTurns} 轮 ${totalTools} 次工具（${parts}）`;
}

/**
 * 格式化工具调用通知（用于流式显示）
 */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function countLines(s: string): number {
  if (!s) return 0;
  let count = 1;
  for (let i = 0; i < s.length; i++) { if (s[i] === '\n') count++; }
  return count;
}

export function formatToolCallNotification(toolName: string, toolInput?: Record<string, unknown>): string {
  const emoji = getToolEmoji(toolName);
  if (!toolInput) return `${emoji} ${toolName}`;

  let detail = '';
  switch (toolName) {
    case 'Edit': {
      const fp = toolInput.file_path ? String(toolInput.file_path) : '';
      const oldLines = countLines(String(toolInput.old_string ?? ''));
      const newLines = countLines(String(toolInput.new_string ?? ''));
      detail = fp ? ` → ${fp} (-${oldLines}/+${newLines} 行)` : '';
      break;
    }
    case 'Read': {
      const fp = toolInput.file_path ? String(toolInput.file_path) : '';
      const parts = [fp];
      if (toolInput.offset) parts.push(`L${toolInput.offset}`);
      if (toolInput.limit) parts.push(`${toolInput.limit}行`);
      detail = fp ? ` → ${parts.join(' ')}` : '';
      break;
    }
    case 'Write': {
      const fp = toolInput.file_path ? String(toolInput.file_path) : '';
      const len = String(toolInput.content ?? '').length;
      detail = fp ? ` → ${fp} (${len}字符)` : '';
      break;
    }
    case 'Bash':
      if (toolInput.command) detail = ` → ${truncate(String(toolInput.command), 60)}`;
      break;
    case 'Grep':
    case 'Glob':
      if (toolInput.pattern) detail = ` → ${toolInput.pattern}`;
      break;
    case 'WebFetch':
      if (toolInput.url) detail = ` → ${truncate(String(toolInput.url), 60)}`;
      break;
    case 'WebSearch':
      if (toolInput.query) detail = ` → ${toolInput.query}`;
      break;
    case 'Task':
      if (toolInput.description) detail = ` → ${truncate(String(toolInput.description), 40)}`;
      break;
    default:
      break;
  }

  return `${emoji} ${toolName}${detail}`;
}

/**
 * 累积用户费用统计
 */
export function trackCost(userCosts: Map<string, CostRecord>, userId: string, cost: number, durationMs: number): void {
  const record = userCosts.get(userId) ?? { totalCost: 0, totalDurationMs: 0, requestCount: 0 };
  record.totalCost += cost;
  record.totalDurationMs += durationMs;
  record.requestCount += 1;
  userCosts.set(userId, record);
}

/**
 * 安全的 JSON 序列化，防止循环引用导致异常
 */
export function safeStringify(obj: unknown, indent?: number): string {
  try {
    return JSON.stringify(obj, null, indent);
  } catch {
    return '[unserializable]';
  }
}

const IMAGE_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * 清理超过 1 小时的图片临时文件
 */
export async function cleanOldImages(): Promise<number> {
  let cleaned = 0;
  try {
    const files = await readdir(IMAGE_DIR);
    const now = Date.now();
    await Promise.all(files.map(async (f) => {
      const fp = join(IMAGE_DIR, f);
      try {
        const s = await stat(fp);
        if (now - s.mtimeMs > IMAGE_MAX_AGE_MS) {
          await unlink(fp);
          cleaned++;
        }
      } catch { /* ignore per-file errors */ }
    }));
  } catch { /* dir may not exist */ }
  return cleaned;
}
