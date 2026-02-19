import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { writeFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { createLogger } from '../logger.js';
import { APP_HOME } from '../constants.js';

const log = createLogger('Session');

const SESSIONS_FILE = join(APP_HOME, 'data', 'sessions.json');

export interface ThreadSession {
  sessionId?: string;       // Claude Code 会话 ID
  workDir: string;          // 该话题的工作目录
  rootMessageId: string;    // 话题根消息 ID（用于 reply API）
  threadId: string;         // 飞书话题 ID（omt_ 前缀）
  displayName?: string;     // 话题显示名（短标题，用于列表展示）
  description?: string;     // 话题描述（完整的首条消息内容）
}

interface UserSession {
  sessionId?: string;
  workDir: string;
  activeConvId?: string;
  threads?: Record<string, ThreadSession>;  // threadId → ThreadSession
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

  async setWorkDir(userId: string, workDir: string): Promise<string> {
    const currentDir = this.getWorkDir(userId);
    const resolved = resolve(currentDir, workDir);
    if (!existsSync(resolved)) {
      throw new Error(`目录不存在: ${resolved}`);
    }
    // 解析符号链接获取真实路径，防止路径遍历攻击
    const realPath = await realpath(resolved);
    // Check path is under an allowed base directory
    const allowed = this.allowedBaseDirs.some(
      (base) => realPath === base || realPath.startsWith(base + '/')
    );
    if (!allowed) {
      throw new Error(`目录不在允许范围内: ${realPath}\n允许的目录: ${this.allowedBaseDirs.join(', ')}`);
    }
    const session = this.sessions.get(userId);
    if (session) {
      // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
      if (session.activeConvId && session.sessionId) {
        this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
      }
      session.workDir = realPath;
      session.sessionId = undefined;
      session.activeConvId = this.generateConvId();
    } else {
      this.sessions.set(userId, { workDir: realPath, activeConvId: this.generateConvId() });
    }
    // 切换目录也立即同步保存，确保会话重置生效
    this.flushSync();
    log.info(`WorkDir changed for user ${userId}: ${realPath}, session cleared`);
    return realPath;
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

  // ─── Thread Session Methods ───

  getThreadSession(userId: string, threadId: string): ThreadSession | undefined {
    return this.sessions.get(userId)?.threads?.[threadId];
  }

  setThreadSession(userId: string, threadId: string, session: ThreadSession): void {
    const userSession = this.sessions.get(userId);
    if (userSession) {
      if (!userSession.threads) userSession.threads = {};
      userSession.threads[threadId] = session;
    } else {
      this.sessions.set(userId, {
        workDir: this.defaultWorkDir,
        activeConvId: this.generateConvId(),
        threads: { [threadId]: session },
      });
    }
    this.save();
  }

  removeThreadSession(userId: string, threadId: string): void {
    const threads = this.sessions.get(userId)?.threads;
    if (threads) {
      delete threads[threadId];
      this.flushSync();
    }
  }

  getSessionIdForThread(userId: string, threadId: string): string | undefined {
    return this.sessions.get(userId)?.threads?.[threadId]?.sessionId;
  }

  setSessionIdForThread(userId: string, threadId: string, sessionId: string): void {
    const thread = this.sessions.get(userId)?.threads?.[threadId];
    if (thread) {
      thread.sessionId = sessionId;
      this.save();
    }
  }

  getWorkDirForThread(userId: string, threadId: string): string {
    return this.sessions.get(userId)?.threads?.[threadId]?.workDir ?? this.getWorkDir(userId);
  }

  async setWorkDirForThread(userId: string, threadId: string, workDir: string, rootMessageId?: string): Promise<string> {
    let thread = this.sessions.get(userId)?.threads?.[threadId];
    if (!thread) {
      // 话题会话尚未创建（如首条消息就是 /cd），自动初始化
      this.setThreadSession(userId, threadId, {
        workDir: this.getWorkDir(userId),
        rootMessageId: rootMessageId ?? '',
        threadId,
      });
      thread = this.sessions.get(userId)?.threads?.[threadId];
      if (!thread) {
        throw new Error(`Failed to initialize thread session: user=${userId}, thread=${threadId}`);
      }
    }
    const resolved = resolve(thread.workDir, workDir);
    if (!existsSync(resolved)) {
      throw new Error(`目录不存在: ${resolved}`);
    }
    // 解析符号链接获取真实路径，防止路径遍历攻击
    const realPath = await realpath(resolved);
    const allowed = this.allowedBaseDirs.some(
      (base) => realPath === base || realPath.startsWith(base + '/')
    );
    if (!allowed) {
      throw new Error(`目录不在允许范围内: ${realPath}\n允许的目录: ${this.allowedBaseDirs.join(', ')}`);
    }
    thread.workDir = realPath;
    thread.sessionId = undefined; // 切换目录重置会话
    this.flushSync();
    log.info(`Thread ${threadId} workDir changed for user ${userId}: ${realPath}`);
    return realPath;
  }

  newThreadSession(userId: string, threadId: string): boolean {
    const thread = this.sessions.get(userId)?.threads?.[threadId];
    if (thread) {
      thread.sessionId = undefined;
      this.flushSync();
      log.info(`Thread session reset: user=${userId}, thread=${threadId}`);
      return true;
    }
    return false;
  }

  removeThreadByRootMessageId(rootMessageId: string): boolean {
    for (const [, session] of this.sessions) {
      if (!session.threads) continue;
      for (const [threadId, thread] of Object.entries(session.threads)) {
        if (thread.rootMessageId === rootMessageId) {
          delete session.threads[threadId];
          this.save();
          return true;
        }
      }
    }
    return false;
  }

  listThreads(userId: string): ThreadSession[] {
    const threads = this.sessions.get(userId)?.threads;
    if (!threads) return [];
    return Object.values(threads);
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
    // 取消挂起的防抖保存，防止旧数据覆写刚同步写入的内容
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
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
