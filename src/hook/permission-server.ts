import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '../logger.js';
import { PERMISSION_REQUEST_TIMEOUT_MS, MAX_BODY_SIZE } from '../constants.js';
import type { ThreadContext } from '../shared/types.js';

export type { ThreadContext };

const log = createLogger('PermissionServer');

export interface PermissionSender {
  sendPermissionCard(chatId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>, threadCtx?: ThreadContext): Promise<string>;
  updatePermissionCard(chatId: string, messageId: string, toolName: string, decision: 'allow' | 'deny'): Promise<void>;
}

const senders = new Map<string, PermissionSender>();

export function registerPermissionSender(platform: string, s: PermissionSender) {
  senders.set(platform, s);
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

// Resolve the latest pending request for a given chatId
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

  oldest.resolve(decision);
  const platformSender = senders.get(oldest.platform);
  platformSender?.updatePermissionCard(oldest.chatId, oldest.messageId, oldest.toolName, decision).catch(() => {});
  pendingRequests.delete(oldest.id);
  removeFromIndex(chatId, oldest.id);
  return oldest.id;
}

export function getPendingCount(chatId: string): number {
  return chatIdIndex.get(chatId)?.size ?? 0;
}

export function listPending(chatId: string): PendingRequest[] {
  const ids = chatIdIndex.get(chatId);
  if (!ids) return [];
  const result: PendingRequest[] = [];
  for (const id of ids) {
    const req = pendingRequests.get(id);
    if (req) result.push(req);
  }
  return result.sort((a, b) => a.createdAt - b.createdAt);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error(`Request body too large (>${MAX_BODY_SIZE} bytes)`));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
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
      const { chatId, toolName, toolInput, threadRootMsgId, threadId, platform } = body;

      if (!chatId || !toolName) {
        sendJson(res, 400, { error: 'chatId and toolName are required' });
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

        // 超时定时器在发卡片之前启动，确保总等待时间不超过上限
        const timeout = setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            removeFromIndex(chatId, id);
            log.warn(`Permission request ${id} timed out`);
            if (savedMessageId) {
              platformSender.updatePermissionCard(chatId, savedMessageId, toolName, 'deny').catch(() => {});
            }
          }
          safeResolve('deny');
        }, PERMISSION_REQUEST_TIMEOUT_MS);

        platformSender.sendPermissionCard(chatId, id, toolName, toolInput ?? {}, threadCtx).then((messageId) => {
          savedMessageId = messageId;
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
        }).catch((err) => {
          log.error('Failed to send permission card:', err);
          clearTimeout(timeout);
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

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok', pending: pendingRequests.size });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

export function startPermissionServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        log.error('Unhandled error in permission server:', err);
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'Internal error' });
        }
      });
    });

    server.listen(port, '127.0.0.1', () => {
      log.info(`Permission server listening on 127.0.0.1:${port}`);
      resolve();
    });
  });
}
