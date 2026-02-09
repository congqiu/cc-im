import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SESSIONS_FILE = 'data/sessions.json';

interface UserSession {
  sessionId?: string;
  workDir: string;
}

export class SessionManager {
  private sessions: Map<string, UserSession> = new Map();
  private defaultWorkDir: string;

  constructor(defaultWorkDir: string) {
    this.defaultWorkDir = defaultWorkDir;
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
    const resolved = resolve(workDir);
    if (!existsSync(resolved)) {
      throw new Error(`目录不存在: ${resolved}`);
    }
    const session = this.sessions.get(userId);
    if (session) {
      session.workDir = resolved;
      session.sessionId = undefined; // 切换目录时清除 session
    } else {
      this.sessions.set(userId, { workDir: resolved });
    }
    this.save();
    return resolved;
  }

  clearSession(userId: string): boolean {
    const session = this.sessions.get(userId);
    if (session?.sessionId) {
      session.sessionId = undefined;
      this.save();
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
          } else {
            this.sessions.set(key, val as UserSession);
          }
        }
        console.log(`[Session] Loaded ${this.sessions.size} sessions`);
      }
    } catch {
      console.log('[Session] No existing sessions found, starting fresh');
    }
  }

  private save() {
    try {
      const dir = dirname(SESSIONS_FILE);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const obj: Record<string, UserSession> = {};
      for (const [key, val] of this.sessions) {
        obj[key] = val;
      }
      writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
    } catch (err) {
      console.error('[Session] Failed to save sessions:', err);
    }
  }
}
