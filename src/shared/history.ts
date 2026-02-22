import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  page: number;
  totalPages: number;
  sessionId: string;
}

const PAGE_SIZE = 10;

function encodeWorkDir(dir: string): string {
  return dir.replace(/\//g, '-');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === 'text' && b.text)
      .map((b: Record<string, unknown>) => String(b.text))
      .join('\n');
  }
  return '';
}

export type HistoryResult = { ok: true; data: HistoryPage } | { ok: false; error: string };

export async function getHistory(workDir: string, sessionId: string | undefined, page: number): Promise<HistoryResult> {
  const projectDir = join(homedir(), '.claude', 'projects', encodeWorkDir(workDir));

  if (!sessionId) {
    let files: string[];
    try {
      files = (await readdir(projectDir)).filter(f => f.endsWith('.jsonl'));
    } catch {
      return { ok: false, error: '未找到会话记录目录。' };
    }
    if (files.length === 0) return { ok: false, error: '未找到会话记录。' };
    // 按修改时间排序取最新
    const withMtime = await Promise.all(
      files.map(async f => ({ f, mtime: (await stat(join(projectDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))
    );
    withMtime.sort((a, b) => a.mtime - b.mtime);
    sessionId = withMtime[withMtime.length - 1].f.replace('.jsonl', '');
  }

  const filePath = join(projectDir, `${sessionId}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch {
    return { ok: false, error: `未找到会话文件: ${sessionId}` };
  }

  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const type = obj.type;
      if (type !== 'user' && type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg) continue;
      const text = extractText(msg.content).trim();
      if (!text) continue;
      if (text.startsWith('<local-command') || text.startsWith('<command-name>')) continue;
      entries.push({ role: msg.role, text, timestamp: obj.timestamp });
    } catch { /* skip malformed lines */ }
  }

  if (entries.length === 0) return { ok: false, error: '会话中没有可显示的消息。' };

  const totalPages = Math.ceil(entries.length / PAGE_SIZE);
  const p = Math.max(1, Math.min(page, totalPages));
  const start = (p - 1) * PAGE_SIZE;
  const pageEntries = entries.slice(start, start + PAGE_SIZE);

  return { ok: true, data: { entries: pageEntries, page: p, totalPages, sessionId } };
}

export function formatHistoryPage(result: HistoryPage): string {
  const lines = [`📜 会话历史 (${result.page}/${result.totalPages}) — ${result.sessionId.slice(-8)}`, ''];
  for (const e of result.entries) {
    const prefix = e.role === 'user' ? '👤' : '🤖';
    const preview = e.text.length > 300 ? e.text.slice(0, 297) + '...' : e.text;
    lines.push(`${prefix} ${preview}`);
  }
  if (result.page < result.totalPages) {
    lines.push('', `使用 /history ${result.page + 1} 查看下一页`);
  }
  return lines.join('\n');
}
