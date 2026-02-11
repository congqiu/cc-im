import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger } from '../logger.js';
import { PERMISSION_REQUEST_TIMEOUT_MS } from '../constants.js';

const log = createLogger('PermissionServer');

export interface PermissionSender {
  sendPermissionCard(chatId: string, requestId: string, toolName: string, toolInput: Record<string, unknown>): Promise<string>;
  updatePermissionCard(chatId: string, messageId: string, toolName: string, decision: 'allow' | 'deny'): Promise<void>;
}

let sender: PermissionSender | null = null;

export function setPermissionSender(s: PermissionSender) {
  sender = s;
}

export interface PendingRequest {
  id: string;
  chatId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  messageId: string;
  createdAt: number;
  resolve: (decision: 'allow' | 'deny') => void;
}

const pendingRequests = new Map<string, PendingRequest>();

// Resolve the latest pending request for a given chatId
export function resolveLatestPermission(chatId: string, decision: 'allow' | 'deny'): string | null {
  let oldest: PendingRequest | null = null;
  for (const req of pendingRequests.values()) {
    if (req.chatId === chatId) {
      if (!oldest || req.createdAt < oldest.createdAt) {
        oldest = req;
      }
    }
  }
  if (!oldest) return null;

  oldest.resolve(decision);
  sender?.updatePermissionCard(oldest.chatId, oldest.messageId, oldest.toolName, decision).catch(() => {});
  pendingRequests.delete(oldest.id);
  return oldest.id;
}

export function getPendingCount(chatId: string): number {
  let count = 0;
  for (const req of pendingRequests.values()) {
    if (req.chatId === chatId) count++;
  }
  return count;
}

export function listPending(chatId: string): PendingRequest[] {
  const result: PendingRequest[] = [];
  for (const req of pendingRequests.values()) {
    if (req.chatId === chatId) result.push(req);
  }
  return result.sort((a, b) => a.createdAt - b.createdAt);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
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
      const { chatId, toolName, toolInput } = body;

      if (!chatId || !toolName) {
        sendJson(res, 400, { error: 'chatId and toolName are required' });
        return;
      }

      const id = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let savedMessageId = '';

      const decision = await new Promise<'allow' | 'deny'>((resolve) => {
        if (!sender) {
          log.error('Permission sender not configured');
          resolve('deny');
          return;
        }

        sender.sendPermissionCard(chatId, id, toolName, toolInput ?? {}).then((messageId) => {
          savedMessageId = messageId;
          const pending: PendingRequest = {
            id,
            chatId,
            toolName,
            toolInput: toolInput ?? {},
            messageId,
            createdAt: Date.now(),
            resolve,
          };
          pendingRequests.set(id, pending);
          log.info(`Permission request created: ${id} tool=${toolName}`);
        }).catch((err) => {
          log.error('Failed to send permission card:', err);
          resolve('deny');
        });

        setTimeout(() => {
          if (pendingRequests.has(id)) {
            pendingRequests.delete(id);
            log.warn(`Permission request ${id} timed out`);
            if (savedMessageId) {
              sender?.updatePermissionCard(chatId, savedMessageId, toolName, 'deny').catch(() => {});
            }
            resolve('deny');
          }
        }, PERMISSION_REQUEST_TIMEOUT_MS);
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
