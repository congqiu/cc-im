import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../config.js';
import { AccessControl } from '../access/access-control.js';
import { SessionManager } from '../session/session-manager.js';
import { RequestQueue } from '../queue/request-queue.js';
import { runClaude } from '../claude/cli-runner.js';
import { sendThinkingCard, updateCard, sendFinalCards, sendTextReply } from './message-sender.js';
import { createLogger } from '../logger.js';

const log = createLogger('EventHandler');

export function createEventDispatcher(config: Config) {
  const accessControl = new AccessControl(config.allowedUserIds);
  const sessionManager = new SessionManager(config.claudeWorkDir);
  const requestQueue = new RequestQueue();

  // Dedup: track processed message IDs
  const processedMessages = new Set<string>();

  const dispatcher = new Lark.EventDispatcher({});

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      const message = data.message;
      const messageId = message.message_id;

      // Dedup
      if (processedMessages.has(messageId)) return;
      processedMessages.add(messageId);
      // Evict old entries to prevent memory leak
      if (processedMessages.size > 10000) {
        const entries = [...processedMessages];
        for (let i = 0; i < 5000; i++) {
          processedMessages.delete(entries[i]);
        }
      }

      const chatId = message.chat_id;
      const senderId = data.sender?.sender_id?.open_id;

      if (!senderId) return;

      // Access control
      if (!accessControl.isAllowed(senderId)) {
        log.warn(`Access denied for user: ${senderId}`);
        await sendTextReply(chatId, '抱歉，您没有使用此机器人的权限。');
        return;
      }

      // Parse message content
      const msgType = message.message_type;
      if (msgType !== 'text') {
        await sendTextReply(chatId, '目前仅支持文本消息。');
        return;
      }

      let text: string;
      try {
        text = JSON.parse(message.content).text;
      } catch {
        return;
      }

      if (!text?.trim()) return;

      log.info(`User ${senderId}: ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`);

      // Handle /clear command
      if (text.trim() === '/clear') {
        sessionManager.clearSession(senderId);
        await sendTextReply(chatId, '会话已清除，下次对话将开始新的上下文。');
        return;
      }

      // Handle /cd command
      if (text.trim().startsWith('/cd ')) {
        const dir = text.trim().slice(4).trim();
        if (!dir) {
          await sendTextReply(chatId, `当前工作目录: ${sessionManager.getWorkDir(senderId)}`);
          return;
        }
        try {
          const resolved = sessionManager.setWorkDir(senderId, dir);
          log.info(`User ${senderId} changed workDir to: ${resolved}`);
          await sendTextReply(chatId, `工作目录已切换到: ${resolved}\n会话已重置。`);
        } catch (err: any) {
          await sendTextReply(chatId, err.message);
        }
        return;
      }

      // Handle /pwd command
      if (text.trim() === '/pwd') {
        await sendTextReply(chatId, `当前工作目录: ${sessionManager.getWorkDir(senderId)}`);
        return;
      }

      // Handle /list command
      if (text.trim() === '/list') {
        const dirs = listClaudeProjects();
        if (dirs.length === 0) {
          await sendTextReply(chatId, '未找到 Claude Code 工作区记录。');
        } else {
          const current = sessionManager.getWorkDir(senderId);
          const lines = dirs.map((d) => (d === current ? `▶ ${d}` : `  ${d}`));
          await sendTextReply(chatId, `Claude Code 工作区列表:\n${lines.join('\n')}\n\n使用 /cd <路径> 切换`);
        }
        return;
      }

      // Enqueue the task
      const accepted = requestQueue.enqueue(senderId, text, async (prompt) => {
        await handleClaudeRequest(config, sessionManager, senderId, chatId, prompt);
      });

      if (!accepted) {
        log.warn(`Queue full for user: ${senderId}`);
        await sendTextReply(chatId, '您的请求队列已满，请等待当前任务完成后再试。');
      }
    },
  });

  return dispatcher;
}

async function handleClaudeRequest(
  config: Config,
  sessionManager: SessionManager,
  userId: string,
  chatId: string,
  prompt: string,
) {
  const sessionId = sessionManager.getSessionId(userId);
  const workDir = sessionManager.getWorkDir(userId);

  log.info(`Running Claude for user ${userId}, workDir=${workDir}, sessionId=${sessionId ?? 'new'}`);

  // Send thinking card
  let messageId: string;
  try {
    messageId = await sendThinkingCard(chatId);
  } catch (err) {
    log.error('Failed to send thinking card:', err);
    return;
  }

  if (!messageId) {
    log.error('No message_id returned for thinking card');
    return;
  }

  return new Promise<void>((resolve) => {
    let lastUpdateTime = 0;
    let pendingUpdate: ReturnType<typeof setTimeout> | null = null;

    const throttledUpdate = (content: string) => {
      const now = Date.now();
      const elapsed = now - lastUpdateTime;

      if (elapsed >= 500) {
        lastUpdateTime = now;
        updateCard(messageId, content, 'streaming', '输出中...');
      } else if (!pendingUpdate) {
        pendingUpdate = setTimeout(() => {
          pendingUpdate = null;
          lastUpdateTime = Date.now();
          updateCard(messageId, content, 'streaming', '输出中...');
        }, 500 - elapsed);
      }
    };

    const handle = runClaude(config.claudeCliPath, prompt, sessionId, workDir, {
      onSessionId: (id) => {
        sessionManager.setSessionId(userId, id);
        log.info(`Session created for user ${userId}: ${id}`);
      },
      onText: (accumulated) => {
        throttledUpdate(accumulated);
      },
      onComplete: async (result) => {
        if (pendingUpdate) {
          clearTimeout(pendingUpdate);
          pendingUpdate = null;
        }

        const note = result.cost > 0
          ? `耗时 ${(result.durationMs / 1000).toFixed(1)}s | 费用 $${result.cost.toFixed(4)}`
          : '完成';

        log.info(`Claude completed for user ${userId}: success=${result.success}, cost=$${result.cost.toFixed(4)}`);

        const finalContent = result.result || '(无输出)';
        try {
          await sendFinalCards(chatId, messageId, finalContent, note);
        } catch (err) {
          log.error('Failed to send final cards:', err);
        }
        resolve();
      },
      onError: async (error) => {
        if (pendingUpdate) {
          clearTimeout(pendingUpdate);
          pendingUpdate = null;
        }

        log.error(`Claude error for user ${userId}: ${error}`);

        try {
          await updateCard(messageId, `错误：${error}`, 'error', '执行失败');
        } catch (err) {
          log.error('Failed to send error card:', err);
        }
        resolve();
      },
    });
  });
}

function listClaudeProjects(): string[] {
  const configPath = join(homedir(), '.claude.json');
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf-8'));
    const projects: Record<string, unknown> = data.projects ?? {};
    return Object.keys(projects).sort();
  } catch {
    return [];
  }
}
