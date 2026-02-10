import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('Session');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const SESSIONS_FILE = join(PROJECT_ROOT, 'data', 'sessions.json');

interface UserSession {
  sessionId?: string;
  workDir: string;
}

function isUserSession(val: unknown): val is UserSession {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.workDir === 'string';
}

export class SessionManager {
  private sessions: Map<string, UserSession> = new Map();
  private defaultWorkDir: string;
  private allowedBaseDirs: string[];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 500;

  constructor(defaultWorkDir: string, allowedBaseDirs: string[]) {
    this.defaultWorkDir = defaultWorkDir;
    this.allowedBaseDirs = allowedBaseDirs;
    this.load();
  }

  getSessionId(userId: string): string | undefined {
    return this.sessions.get(userId)?.sessionId;
  }

  setSessionId(userId: string, sessionId: string) {
    const session = this.sessions.get(userId);
    if (session) {
      session.sessionId = sessionId;
    } else {
      this.sessions.set(userId, { sessionId, workDir: this.defaultWorkDir });
    }
    this.save();
  }

  getWorkDir(userId: string): string {
    return this.sessions.get(userId)?.workDir ?? this.defaultWorkDir;
  }

  setWorkDir(userId: string, workDir: string): string {
    const currentDir = this.getWorkDir(userId);
    const resolved = resolve(currentDir, workDir);
    if (!existsSync(resolved)) {
      throw new Error(`目录不存在: ${resolved}`);
    }
    // Check path is under an allowed base directory
    const allowed = this.allowedBaseDirs.some(
      (base) => resolved === base || resolved.startsWith(base + '/')
    );
    if (!allowed) {
      throw new Error(`目录不在允许范围内: ${resolved}\n允许的目录: ${this.allowedBaseDirs.join(', ')}`);
    }
    const session = this.sessions.get(userId);
    if (session) {
      session.workDir = resolved;
      session.sessionId = undefined; // 切换目录时清除 session
    } else {
      this.sessions.set(userId, { workDir: resolved });
    }
    // 切换目录也立即同步保存，确保会话重置生效
    this.flushSync();
    log.info(`WorkDir changed for user ${userId}: ${resolved}, session cleared`);
    return resolved;
  }

  clearSession(userId: string): boolean {
    const session = this.sessions.get(userId);
    if (session?.sessionId) {
      session.sessionId = undefined;
      // 立即同步保存，确保清除操作生效
      this.flushSync();
      log.info(`Session cleared for user: ${userId}`);
      return true;
    }
    return false;
  }

  private load() {
    try {
      if (existsSync(SESSIONS_FILE)) {
        const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
        for (const [key, val] of Object.entries(data)) {
          if (typeof val === 'string') {
            // Migrate old format: userId -> sessionId
            this.sessions.set(key, { sessionId: val, workDir: this.defaultWorkDir });
          } else if (isUserSession(val)) {
            this.sessions.set(key, val);
          }
        }
        log.info(`Loaded ${this.sessions.size} sessions`);
      }
    } catch {
      log.info('No existing sessions found, starting fresh');
    }
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SessionManager.SAVE_DEBOUNCE_MS);
  }

  private flush() {
    try {
      const dir = dirname(SESSIONS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const obj: Record<string, UserSession> = {};
      for (const [key, val] of this.sessions) {
        obj[key] = val;
      }
      writeFile(SESSIONS_FILE, JSON.stringify(obj, null, 2)).catch((err) => {
        log.error('Failed to save sessions:', err);
      });
    } catch (err) {
      log.error('Failed to save sessions:', err);
    }
  }

  private flushSync() {
    try {
      const dir = dirname(SESSIONS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const obj: Record<string, UserSession> = {};
      for (const [key, val] of this.sessions) {
        obj[key] = val;
      }
      writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
      log.info('Sessions saved synchronously');
    } catch (err) {
      log.error('Failed to save sessions synchronously:', err);
      throw err;
    }
  }
}
