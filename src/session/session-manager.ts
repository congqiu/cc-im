import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
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
  totalTurns?: number;      // 累计对话轮次
  claudeModel?: string;     // 话题指定的模型（覆盖用户级默认）
}

interface UserSession {
  sessionId?: string;
  workDir: string;
  activeConvId?: string;
  threads?: Record<string, ThreadSession>;  // threadId → ThreadSession
  totalTurns?: number;      // 累计对话轮次
  claudeModel?: string;     // 用户指定的模型（覆盖全局默认）
}

function isUserSession(val: unknown): val is UserSession {
  if (typeof val !== 'object' || val === null) return false;
  const obj = val as Record<string, unknown>;
  return typeof obj.workDir === 'string';
}

export class SessionManager {
  private sessions: Map<string, UserSession> = new Map();
  private convSessionMap: Map<string, string> = new Map(); // userId:convId -> sessionId
  private rootMsgIndex: Map<string, { userId: string; threadId: string }> = new Map(); // rootMessageId -> location
  private static readonly MAX_CONV_SESSION_MAP_SIZE = 200;
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
      this.pruneConvSessionMap();
    }
  }

  private pruneConvSessionMap() {
    while (this.convSessionMap.size > SessionManager.MAX_CONV_SESSION_MAP_SIZE) {
      const oldest = this.convSessionMap.keys().next().value;
      if (oldest !== undefined) this.convSessionMap.delete(oldest);
      else break;
    }
  }

  getWorkDir(userId: string): string {
    return this.sessions.get(userId)?.workDir ?? this.defaultWorkDir;
  }

  private async resolveAndValidatePath(baseDir: string, targetDir: string): Promise<string> {
    const resolved = resolve(baseDir, targetDir);
    if (!existsSync(resolved)) {
      throw new Error(`目录不存在: ${resolved}`);
    }
    const realPath = await realpath(resolved);
    const allowed = this.allowedBaseDirs.some(
      (base) => realPath === base || realPath.startsWith(base + '/')
    );
    if (!allowed) {
      throw new Error(`目录不在允许范围内: ${realPath}\n允许的目录: ${this.allowedBaseDirs.join(', ')}`);
    }
    return realPath;
  }

  async setWorkDir(userId: string, workDir: string): Promise<string> {
    const currentDir = this.getWorkDir(userId);
    const realPath = await this.resolveAndValidatePath(currentDir, workDir);
    const session = this.sessions.get(userId);
    if (session) {
      // 转存旧 convId 的 sessionId，供仍在运行的旧任务使用
      if (session.activeConvId && session.sessionId) {
        this.convSessionMap.set(`${userId}:${session.activeConvId}`, session.sessionId);
        this.pruneConvSessionMap();
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
        this.pruneConvSessionMap();
      }
      session.sessionId = undefined;
      session.activeConvId = this.generateConvId();
      session.totalTurns = 0;
      this.flushSync();
      log.info(`New session started for user: ${userId}`);
      return true;
    }
    return false;
  }

  addTurns(userId: string, turns: number): number {
    const session = this.sessions.get(userId);
    if (!session) return 0;
    session.totalTurns = (session.totalTurns ?? 0) + turns;
    return session.totalTurns;
  }

  addTurnsForThread(userId: string, threadId: string, turns: number): number {
    const thread = this.sessions.get(userId)?.threads?.[threadId];
    if (!thread) return 0;
    thread.totalTurns = (thread.totalTurns ?? 0) + turns;
    return thread.totalTurns;
  }

  getModel(userId: string, threadId?: string): string | undefined {
    const session = this.sessions.get(userId);
    if (threadId) {
      const threadModel = session?.threads?.[threadId]?.claudeModel;
      if (threadModel) return threadModel;
    }
    return session?.claudeModel;
  }

  setModel(userId: string, model: string | undefined, threadId?: string): void {
    if (threadId) {
      const thread = this.sessions.get(userId)?.threads?.[threadId];
      if (thread) {
        thread.claudeModel = model;
        this.save();
        return;
      }
    }
    const session = this.sessions.get(userId);
    if (session) {
      session.claudeModel = model;
    } else {
      this.sessions.set(userId, { workDir: this.defaultWorkDir, activeConvId: this.generateConvId(), claudeModel: model });
    }
    this.save();
  }

  // ─── Thread Session Methods ───

  getThreadSession(userId: string, threadId: string): ThreadSession | undefined {
    return this.sessions.get(userId)?.threads?.[threadId];
  }

  setThreadSession(userId: string, threadId: string, session: ThreadSession): void {
    // 清除旧的 rootMsgIndex 条目（如果该 threadId 已有旧 session）
    const oldThread = this.sessions.get(userId)?.threads?.[threadId];
    if (oldThread?.rootMessageId) {
      this.rootMsgIndex.delete(oldThread.rootMessageId);
    }
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
    // 维护反向索引
    if (session.rootMessageId) {
      this.rootMsgIndex.set(session.rootMessageId, { userId, threadId });
    }
    this.save();
  }

  removeThreadSession(userId: string, threadId: string): void {
    const threads = this.sessions.get(userId)?.threads;
    if (threads) {
      const thread = threads[threadId];
      if (thread?.rootMessageId) {
        this.rootMsgIndex.delete(thread.rootMessageId);
      }
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
    const realPath = await this.resolveAndValidatePath(thread.workDir, workDir);
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
      thread.totalTurns = 0;
      this.flushSync();
      log.info(`Thread session reset: user=${userId}, thread=${threadId}`);
      return true;
    }
    return false;
  }

  removeThreadByRootMessageId(rootMessageId: string): boolean {
    const loc = this.rootMsgIndex.get(rootMessageId);
    if (!loc) return false;
    const threads = this.sessions.get(loc.userId)?.threads;
    if (threads && threads[loc.threadId]) {
      delete threads[loc.threadId];
      this.rootMsgIndex.delete(rootMessageId);
      this.save();
      return true;
    }
    // 索引过期，清理
    this.rootMsgIndex.delete(rootMessageId);
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
            // 重建 rootMsgIndex
            if (val.threads) {
              for (const [threadId, thread] of Object.entries(val.threads)) {
                if (thread.rootMessageId) {
                  this.rootMsgIndex.set(thread.rootMessageId, { userId: key, threadId });
                }
              }
            }
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
      this.doFlush();
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
      this.doFlush();
      log.info('Sessions saved synchronously');
    } catch (err) {
      log.error('Failed to save sessions synchronously:', err);
      throw err;
    }
  }

  private doFlush() {
    const dir = dirname(SESSIONS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, UserSession> = {};
    for (const [key, val] of this.sessions) {
      obj[key] = val;
    }
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
  }
}
