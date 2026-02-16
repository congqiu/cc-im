/**
 * 共享工具函数
 */

import type { CostRecord } from './types.js';

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
 * 累积用户费用统计
 */
export function trackCost(userCosts: Map<string, CostRecord>, userId: string, cost: number, durationMs: number): void {
  const record = userCosts.get(userId) ?? { totalCost: 0, totalDurationMs: 0, requestCount: 0 };
  record.totalCost += cost;
  record.totalDurationMs += durationMs;
  record.requestCount += 1;
  userCosts.set(userId, record);
}
