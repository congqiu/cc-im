import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentProvider } from '../config.js';

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
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

function encodeWorkDir(dir: string): string {
  return dir.replace(/\//g, '-');
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => (b.type === 'text' || b.type === 'output_text') && b.text)
      .map((b: Record<string, unknown>) => String(b.text))
      .join('\n');
  }
  return '';
}

function shouldSkipMessage(text: string): boolean {
  return text.startsWith('<local-command') || text.startsWith('<command-name>');
}

function getClaudeProjectDir(workDir: string): string {
  return join(CLAUDE_PROJECTS_DIR, encodeWorkDir(workDir));
}

interface ParsedSessionFile {
  sessionId?: string;
  cwd?: string;
  entries: HistoryEntry[];
  messageCount: number;
  preview: string;
}

function parseClaudeSessionFile(raw: string): ParsedSessionFile {
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
      if (!text || shouldSkipMessage(text)) continue;
      entries.push({ role: msg.role, text, timestamp: obj.timestamp });
    } catch { /* skip malformed lines */ }
  }

  return {
    entries,
    messageCount: entries.length,
    preview: entries.find(entry => entry.role === 'user')?.text ?? '',
  };
}

function parseCodexSessionFile(raw: string): ParsedSessionFile {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  const entries: HistoryEntry[] = [];

  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const payload = (obj.payload && typeof obj.payload === 'object'
        ? obj.payload
        : undefined) as Record<string, unknown> | undefined;

      if (obj.type === 'session_meta' && payload) {
        if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
        if (typeof payload.cwd === 'string' && payload.cwd) cwd = payload.cwd;
        continue;
      }

      let role: HistoryEntry['role'] | undefined;
      let text = '';

      if (obj.type === 'event_msg' && payload) {
        if (payload.type === 'user_message') role = 'user';
        if (payload.type === 'agent_message') role = 'assistant';
        if (role) text = extractText(payload.message ?? payload.text).trim();
      }

      if (!role && obj.type === 'response_item' && payload?.type === 'message') {
        const payloadRole = payload.role;
        if (payloadRole === 'user' || payloadRole === 'assistant') {
          role = payloadRole;
          text = extractText(payload.content).trim();
        }
      }

      if (!role || !text || shouldSkipMessage(text)) continue;
      const last = entries[entries.length - 1];
      if (last && last.role === role && last.text === text) continue;
      entries.push({ role, text, timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined });
    } catch { /* skip malformed lines */ }
  }

  return {
    sessionId,
    cwd,
    entries,
    messageCount: entries.length,
    preview: entries.find(entry => entry.role === 'user')?.text ?? '',
  };
}

async function listCodexSessionFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const name of names) {
    const fullPath = join(dir, name);
    const info = await stat(fullPath).catch(() => null);
    if (!info) continue;
    if (typeof info.isDirectory === 'function' && info.isDirectory()) {
      files.push(...await listCodexSessionFiles(fullPath));
      continue;
    }
    if (name.endsWith('.jsonl')) files.push(fullPath);
  }
  return files;
}

async function getLatestClaudeSessionId(projectDir: string): Promise<string | undefined> {
  let files: string[];
  try {
    files = (await readdir(projectDir)).filter(f => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  const withMtime = await Promise.all(
    files.map(async f => ({ f, mtime: (await stat(join(projectDir, f)).catch(() => ({ mtimeMs: 0 }))).mtimeMs }))
  );
  withMtime.sort((a, b) => a.mtime - b.mtime);
  return withMtime[withMtime.length - 1]?.f.replace('.jsonl', '');
}

interface CodexSessionCandidate {
  filePath: string;
  sessionId: string;
  mtime: number;
  parsed: ParsedSessionFile;
}

async function findCodexSessions(workDir: string): Promise<CodexSessionCandidate[]> {
  const files = await listCodexSessionFiles(CODEX_SESSIONS_DIR);
  const parsed = await Promise.all(files.map(async (filePath) => {
    const raw = await readFile(filePath, 'utf-8').catch(() => '');
    if (!raw) return null;
    const session = parseCodexSessionFile(raw);
    if (!session.sessionId || session.cwd !== workDir) return null;
    const info = await stat(filePath).catch(() => ({ mtimeMs: 0 }));
    return {
      filePath,
      sessionId: session.sessionId,
      mtime: info.mtimeMs,
      parsed: session,
    } satisfies CodexSessionCandidate;
  }));

  return parsed
    .filter((item): item is CodexSessionCandidate => item !== null)
    .sort((a, b) => b.mtime - a.mtime);
}

export type HistoryResult = { ok: true; data: HistoryPage } | { ok: false; error: string };

export async function getHistory(
  workDir: string,
  sessionId: string | undefined,
  page: number,
  provider: AgentProvider = 'claude',
): Promise<HistoryResult> {
  let entries: HistoryEntry[] = [];

  if (provider === 'codex') {
    const sessions = await findCodexSessions(workDir);
    if (sessions.length === 0) return { ok: false, error: '未找到会话记录。' };
    const target = sessionId
      ? sessions.find(session => session.sessionId === sessionId)
      : sessions[0];
    if (!target) return { ok: false, error: `未找到会话文件: ${sessionId}` };
    sessionId = target.sessionId;
    entries = target.parsed.entries;
  } else {
    const projectDir = getClaudeProjectDir(workDir);

    if (!sessionId) {
      sessionId = await getLatestClaudeSessionId(projectDir);
      if (!sessionId) {
        let files: string[];
        try {
          files = await readdir(projectDir);
        } catch {
          return { ok: false, error: '未找到会话记录目录。' };
        }
        if (files.filter(f => f.endsWith('.jsonl')).length === 0) return { ok: false, error: '未找到会话记录。' };
      }
    }

    if (!sessionId) return { ok: false, error: '未找到会话记录。' };

    const filePath = join(projectDir, `${sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch {
      return { ok: false, error: `未找到会话文件: ${sessionId}` };
    }
    entries = parseClaudeSessionFile(raw).entries;
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
  const parsed = parseClaudeSessionFile(raw);
  const preview = parsed.preview.length > PREVIEW_LENGTH ? parsed.preview.slice(0, PREVIEW_LENGTH) + '...' : parsed.preview;
  return { messageCount: parsed.messageCount, preview };
}

export async function getSessionList(
  workDir: string,
  currentSessionId?: string,
  provider: AgentProvider = 'claude',
): Promise<SessionListResult> {
  if (provider === 'codex') {
    const sessions = await findCodexSessions(workDir);
    if (sessions.length === 0) return { ok: false, error: '当前工作区未找到会话记录。' };

    const items = sessions.slice(0, MAX_SESSION_LIST).map(({ sessionId, mtime, parsed }) => {
      const preview = parsed.preview.length > PREVIEW_LENGTH ? parsed.preview.slice(0, PREVIEW_LENGTH) + '...' : parsed.preview;
      return {
        sessionId,
        mtime,
        messageCount: parsed.messageCount,
        preview: preview || '(空会话)',
        isCurrent: sessionId === currentSessionId,
      };
    });

    return { ok: true, data: items };
  }

  const projectDir = getClaudeProjectDir(workDir);

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
