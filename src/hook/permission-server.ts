import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '../logger.js';
import { PERMISSION_REQUEST_TIMEOUT_MS, MAX_BODY_SIZE } from '../constants.js';
import type { ThreadContext } from '../shared/types.js';
import {
  getWatchEntries, formatWatchNotify,
  type WatchEventName,
} from './watch.js';

export type { ThreadContext };

const log = createLogger('PermissionServer');

export interface PermissionSender {
  sendPermissionCard(chatId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>, threadCtx?: ThreadContext): Promise<string>;
  updatePermissionCard(params: { messageId: string; chatId: string; toolName: string; decision: 'allow' | 'deny' }): Promise<void>;
}

const senders = new Map<string, PermissionSender>();

export function registerPermissionSender(platform: string, s: PermissionSender) {
  senders.set(platform, s);
}

export interface WatchNotifySender {
  sendWatchNotify(chatId: string, text: string, threadCtx?: ThreadContext): Promise<void>;
}

const watchSenders = new Map<string, WatchNotifySender>();

export function registerWatchSender(platform: string, s: WatchNotifySender) {
  watchSenders.set(platform, s);
}

export interface PendingRequest {
  id: string;
  chatId: string;
  platform: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  messageId: string;
  createdAt: number;
  resolve: (decision: 'allow' | 'deny') => void;
}

const pendingRequests = new Map<string, PendingRequest>();
// 反向索引：chatId → Set<requestId>，O(1) 查询
const chatIdIndex = new Map<string, Set<string>>();

function addToIndex(chatId: string, id: string) {
  let set = chatIdIndex.get(chatId);
  if (!set) { set = new Set(); chatIdIndex.set(chatId, set); }
  set.add(id);
}

function removeFromIndex(chatId: string, id: string) {
  const set = chatIdIndex.get(chatId);
  if (set) {
    set.delete(id);
    if (set.size === 0) chatIdIndex.delete(chatId);
  }
}

// Resolve a specific pending request by its ID
export function resolvePermissionById(requestId: string, decision: 'allow' | 'deny'): string | null {
  const pending = pendingRequests.get(requestId);
  if (!pending) return null;

  const waitSec = ((Date.now() - pending.createdAt) / 1000).toFixed(1);
  log.info(`Permission ${decision} for ${pending.toolName} (${requestId}), waited ${waitSec}s`);

  pending.resolve(decision);
  const platformSender = senders.get(pending.platform);
  platformSender?.updatePermissionCard({ messageId: pending.messageId, chatId: pending.chatId, toolName: pending.toolName, decision }).catch(() => {});
  pendingRequests.delete(requestId);
  removeFromIndex(pending.chatId, requestId);
  return requestId;
}

// Resolve the oldest pending request for a given chatId (fallback for /allow, /deny commands)
export function resolveLatestPermission(chatId: string, decision: 'allow' | 'deny'): string | null {
  const ids = chatIdIndex.get(chatId);
  if (!ids || ids.size === 0) return null;

  let oldest: PendingRequest | null = null;
  for (const id of ids) {
    const req = pendingRequests.get(id);
    if (req && (!oldest || req.createdAt < oldest.createdAt)) {
      oldest = req;
    }
  }
  if (!oldest) return null;

  return resolvePermissionById(oldest.id, decision);
}

export function getPendingCount(chatId: string): number {
  return chatIdIndex.get(chatId)?.size ?? 0;
}


function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('Request body read timeout'));
    }, 30000);
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error(`Request body too large (>${MAX_BODY_SIZE} bytes)`));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => { clearTimeout(timeout); resolve(body); });
    req.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', `http://localhost`);

  if (req.method === 'POST' && url.pathname === '/permission-request') {
    try {
      const body = JSON.parse(await readBody(req));

      // 运行时类型验证
      if (typeof body !== 'object' || body === null) {
        sendJson(res, 400, { error: 'Request body must be a JSON object' });
        return;
      }

      const { chatId, toolName, toolInput, threadRootMsgId, threadId, platform } = body;

      if (typeof chatId !== 'string' || !chatId) {
        sendJson(res, 400, { error: 'chatId must be a non-empty string' });
        return;
      }
      if (typeof toolName !== 'string' || !toolName) {
        sendJson(res, 400, { error: 'toolName must be a non-empty string' });
        return;
      }
      if (toolInput !== undefined && (typeof toolInput !== 'object' || toolInput === null)) {
        sendJson(res, 400, { error: 'toolInput must be an object if provided' });
        return;
      }
      if (platform !== undefined && typeof platform !== 'string') {
        sendJson(res, 400, { error: 'platform must be a string if provided' });
        return;
      }
      if (threadRootMsgId !== undefined && typeof threadRootMsgId !== 'string') {
        sendJson(res, 400, { error: 'threadRootMsgId must be a string if provided' });
        return;
      }
      if (threadId !== undefined && typeof threadId !== 'string') {
        sendJson(res, 400, { error: 'threadId must be a string if provided' });
        return;
      }

      // 构造话题上下文（两个字段都存在才构造，避免空字符串导致 reply API 调用失败）
      const threadCtx: ThreadContext | undefined = (threadRootMsgId && threadId)
        ? { rootMessageId: threadRootMsgId, threadId }
        : undefined;

      const resolvedPlatform = platform ?? 'feishu';
      const platformSender = senders.get(resolvedPlatform);

      const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let savedMessageId = '';

      const decision = await new Promise<'allow' | 'deny'>((resolve) => {
        if (!platformSender) {
          log.error(`Permission sender not configured for platform: ${resolvedPlatform}`);
          resolve('deny');
          return;
        }

        let resolved = false;
        const safeResolve = (decision: 'allow' | 'deny') => {
          if (resolved) return;
          resolved = true;
          resolve(decision);
        };

        platformSender.sendPermissionCard(chatId, id, toolName, toolInput ?? {}, threadCtx).then((messageId) => {
          savedMessageId = messageId;

          // 超时定时器在卡片发送成功后才启动，确保用户有完整的决策时间
          const timeout = setTimeout(() => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id);
              removeFromIndex(chatId, id);
              log.warn(`Permission request ${id} timed out`);
              platformSender.updatePermissionCard({ messageId, chatId, toolName, decision: 'deny' }).catch(() => {});
            }
            safeResolve('deny');
          }, PERMISSION_REQUEST_TIMEOUT_MS);

          const pending: PendingRequest = {
            id,
            chatId,
            platform: resolvedPlatform,
            toolName,
            toolInput: toolInput ?? {},
            messageId,
            createdAt: Date.now(),
            resolve: (decision) => {
              clearTimeout(timeout);
              safeResolve(decision);
            },
          };
          pendingRequests.set(id, pending);
          addToIndex(chatId, id);
          log.info(`Permission request created: ${id} tool=${toolName} platform=${resolvedPlatform}`);

          // 定期输出等待日志，帮助诊断用户长时间未响应
          const waitLogTimer = setInterval(() => {
            if (!pendingRequests.has(id)) {
              clearInterval(waitLogTimer);
              return;
            }
            const waitSec = Math.floor((Date.now() - pending.createdAt) / 1000);
            log.info(`Permission request ${id} (${toolName}) waiting for user decision... (${waitSec}s)`);
          }, 30_000);
          waitLogTimer.unref();

          // 请求 resolve 时原始 resolve 已包装过，这里再包装一次以清理 timer
          const originalResolve = pending.resolve;
          pending.resolve = (decision) => {
            clearInterval(waitLogTimer);
            originalResolve(decision);
          };
        }).catch((err) => {
          log.error('Failed to send permission card:', err);
          safeResolve('deny');
        });
      });

      sendJson(res, 200, { id, decision });
    } catch (err) {
      log.error('Error handling permission request:', err);
      sendJson(res, 500, { error: 'Internal error' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/watch-notify') {
    try {
      const body = JSON.parse(await readBody(req));
      const { cwd, eventName, sessionId } = body;
      if (!cwd || !eventName) {
        sendJson(res, 400, { error: 'cwd and eventName required' });
        return;
      }
      const validEvents: WatchEventName[] = ['PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'];
      if (!validEvents.includes(eventName)) {
        sendJson(res, 200, { sent: 0 });
        return;
      }
      const entries = getWatchEntries(cwd, eventName as WatchEventName, sessionId);
      if (entries.length === 0) {
        sendJson(res, 200, { sent: 0 });
        return;
      }
      const message = formatWatchNotify(body);
      let sent = 0;
      for (const entry of entries) {
        const sender = watchSenders.get(entry.platform);
        if (sender) {
          sender.sendWatchNotify(entry.chatId, message, entry.threadCtx).catch((err) => {
            log.warn(`Failed to send watch notify to ${entry.chatId}:`, err);
          });
          sent++;
        }
      }
      sendJson(res, 200, { sent });
    } catch (err) {
      log.error('Error handling watch notify:', err);
      sendJson(res, 500, { error: 'Internal error' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', pending: pendingRequests.size });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

export function startPermissionServer(port: number): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        log.error('Unhandled error in permission server:', err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal error' });
        }
      });
    });

    server.on('error', (err) => {
      log.error(`Permission server failed to start on port ${port}:`, err);
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      log.info(`Permission server listening on 127.0.0.1:${actualPort}`);
      resolve({ port: actualPort, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}
