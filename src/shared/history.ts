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
  const p = page <= 0 ? totalPages : Math.max(1, Math.min(page, totalPages));
  const start = (p - 1) * PAGE_SIZE;
  const pageEntries = entries.slice(start, start + PAGE_SIZE);

  return { ok: true, data: { entries: pageEntries, page: p, totalPages, sessionId } };
}

function formatTimestamp(ts?: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return `[${time}]`;
    }
    return `[${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}]`;
  } catch {
    return '';
  }
}

export interface SessionListItem {
  sessionId: string;
  mtime: number;           // 修改时间戳（毫秒）
  messageCount: number;    // user + assistant 消息数
  preview: string;         // 首条用户消息（截断到 100 字符）
  isCurrent: boolean;      // 是否为当前会话
}

export type SessionListResult =
  | { ok: true; data: SessionListItem[] }
  | { ok: false; error: string };

const MAX_SESSION_LIST = 10;
const PREVIEW_LENGTH = 100;

function parseSessionFile(raw: string): { messageCount: number; preview: string } {
  let messageCount = 0;
  let preview = '';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg) continue;
      const text = extractText(msg.content).trim();
      if (!text) continue;
      if (text.startsWith('<local-command') || text.startsWith('<command-name>')) continue;
      messageCount++;
      if (!preview && msg.role === 'user') {
        preview = text.length > PREVIEW_LENGTH ? text.slice(0, PREVIEW_LENGTH) + '...' : text;
      }
    } catch { /* skip */ }
  }
  return { messageCount, preview };
}

export async function getSessionList(workDir: string, currentSessionId?: string): Promise<SessionListResult> {
  const projectDir = join(homedir(), '.claude', 'projects', encodeWorkDir(workDir));

  let files: string[];
  try {
    files = (await readdir(projectDir)).filter(f => f.endsWith('.jsonl'));
  } catch {
    return { ok: false, error: '当前工作区未找到会话记录。' };
  }
  if (files.length === 0) return { ok: false, error: '当前工作区未找到会话记录。' };

  const withMtime = await Promise.all(
    files.map(async f => ({
      f,
      mtime: (await stat(join(projectDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs,
    }))
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);

  const recent = withMtime.slice(0, MAX_SESSION_LIST);

  const items: SessionListItem[] = await Promise.all(
    recent.map(async ({ f, mtime }) => {
      const sessionId = f.replace('.jsonl', '');
      let messageCount = 0;
      let preview = '';
      try {
        const raw = await readFile(join(projectDir, f), 'utf-8');
        ({ messageCount, preview } = parseSessionFile(raw));
      } catch { /* skip */ }
      return {
        sessionId,
        mtime,
        messageCount,
        preview: preview || '(空会话)',
        isCurrent: sessionId === currentSessionId,
      };
    })
  );

  return { ok: true, data: items };
}

export function formatSessionList(items: SessionListItem[]): string {
  const lines = ['📋 会话列表', ''];
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const d = new Date(s.mtime);
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const current = s.isCurrent ? '\n   ▶ 当前会话' : '';
    lines.push(`${i + 1}. ${date} | ${s.messageCount}条 | ${s.preview}${current}`);
  }
  lines.push('', '使用 /resume <序号> 恢复会话');
  return lines.join('\n');
}

export function formatHistoryPage(result: HistoryPage): string {
  const lines = [`📜 会话历史 (${result.page}/${result.totalPages}) — ${result.sessionId.slice(-8)}`, ''];
  for (const e of result.entries) {
    const prefix = e.role === 'user' ? '👤' : '🤖';
    const ts = formatTimestamp(e.timestamp);
    lines.push(ts ? `${ts} ${prefix} ${e.text}` : `${prefix} ${e.text}`);
  }
  const nav: string[] = [];
  if (result.page > 1) nav.push(`/history ${result.page - 1} 上一页`);
  if (result.page < result.totalPages) nav.push(`/history ${result.page + 1} 下一页`);
  if (nav.length > 0) lines.push('', nav.join('  |  '));
  return lines.join('\n');
}
