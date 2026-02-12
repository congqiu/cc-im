import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
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
  activeConvId?: string;
}

function isUserSession(val: unknown): val is UserSession {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.workDir === 'string';
}

export class SessionManager {
  private sessions: Map<string, UserSession> = new Map();
  private convSessionMap: Map<string, string> = new Map(); // userId:convId -> sessionId
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

  private generateConvId(): string {
    return randomBytes(4).toString('hex');
  }

  getConvId(userId: string): string {
    const session = this.sessions.get(userId);
    if (session) {
      if (!session.activeConvId) {
        session.activeConvId = this.generateConvId();
        this.save();
      }
      return session.activeConvId;
    }
    const convId = this.generateConvId();
    this.sessions.set(userId, { workDir: this.defaultWorkDir, activeConvId: convId });
    this.save();
    return convId;
  }

  getSessionIdForConv(userId: string, convId: string): string | undefined {
    // 如果是当前活跃 convId，直接从 session 读
    const session = this.sessions.get(userId);
    if (session?.activeConvId === convId) {
      return session.sessionId;
    }
    // 否则从 convSessionMap 读（旧 convId 的 sessionId）
    return this.convSessionMap.get(`${userId}:${convId}`);
  }

  setSessionIdForConv(userId: string, convId: string, sessionId: string) {
    const session = this.sessions.get(userId);
    if (session?.activeConvId === convId) {
      session.sessionId = sessionId;
      this.save();
    } else {
      // 旧 convId，存到 convSessionMap
      this.convSessionMap.set(`${userId}:${convId}`, sessionId);
    }
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
      // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
      if (session.activeConvId && session.sessionId) {
        this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
      }
      session.workDir = resolved;
      session.sessionId = undefined;
      session.activeConvId = this.generateConvId();
    } else {
      this.sessions.set(userId, { workDir: resolved, activeConvId: this.generateConvId() });
    }
    // 切换目录也立即同步保存，确保会话重置生效
    this.flushSync();
    log.info(`WorkDir changed for user ${userId}: ${resolved}, session cleared`);
    return resolved;
  }

  newSession(userId: string): boolean {
    const session = this.sessions.get(userId);
    if (session) {
      // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
      if (session.activeConvId && session.sessionId) {
        this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
      }
      session.sessionId = undefined;
      session.activeConvId = this.generateConvId();
      this.flushSync();
      log.info(`New session started for user: ${userId}`);
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
            // 旧数据无 activeConvId，自动生成
            if (!val.activeConvId) {
              val.activeConvId = this.generateConvId();
            }
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
