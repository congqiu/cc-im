/**
 * 共享的 Claude 任务执行逻辑
 * 封装两个平台重复的节流更新、完成统计、竞态保护等代码
 */

import type { Config } from '../config.js';
import type { SessionManager } from '../session/session-manager.js';
import { runClaude, type ClaudeRunHandle } from '../claude/cli-runner.js';
import type { ParsedResult } from '../claude/stream-parser.js';
import type { CostRecord } from './types.js';
import { formatToolStats, formatToolCallNotification, trackCost, getContextWarning } from './utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('ClaudeTask');

/**
 * 平台适配器 — 由各平台提供具体的消息发送实现
 */
export interface TaskAdapter {
  /** 流式内容更新 */
  streamUpdate(content: string, toolNote?: string): void;
  /** 发送完成消息/卡片 */
  sendComplete(content: string, note: string, thinkingText?: string): Promise<void>;
  /** 发送错误消息/卡片 */
  sendError(error: string): Promise<void>;
  /** 思考→文本切换处理（飞书 CardKit 需要重置基线） */
  onThinkingToText?(content: string): void;
  /** 额外清理逻辑（停止 typing 循环、清理 waitingTimer 等） */
  extraCleanup?(): void;
  /** 节流间隔（飞书 80ms，Telegram 200ms） */
  throttleMs: number;
}

/**
 * 任务上下文
 */
export interface TaskContext {
  userId: string;
  chatId: string;
  workDir: string;
  sessionId: string | undefined;
  convId?: string;
  threadId?: string;
  threadRootMsgId?: string;
  platform: string;
  taskKey: string;
}

/**
 * 由 runClaudeTask 回传给调用方的可变状态对象
 * 调用方可存入 runningTasks Map，任务运行期间 latestContent 持续更新
 */
export interface TaskRunState {
  handle: ClaudeRunHandle;
  latestContent: string;
  settle: () => void;
  startedAt: number;
}

/**
 * 构建完成 note（耗时/费用/工具统计/模型/上下文警告）
 */
function buildCompletionNote(
  result: ParsedResult,
  sessionManager: SessionManager,
  ctx: TaskContext,
): string {
  const toolInfo = formatToolStats(result.toolStats, result.numTurns);
  const noteParts: string[] = [];
  if (result.cost > 0) {
    noteParts.push(`耗时 ${(result.durationMs / 1000).toFixed(1)}s`);
    noteParts.push(`费用 $${result.cost.toFixed(4)}`);
  } else {
    noteParts.push('完成');
  }
  if (toolInfo) noteParts.push(toolInfo);
  if (result.model) noteParts.push(result.model);

  // 轮次追踪 & 上下文警告
  const totalTurns = ctx.threadId
    ? sessionManager.addTurnsForThread(ctx.userId, ctx.threadId, result.numTurns)
    : sessionManager.addTurns(ctx.userId, result.numTurns);
  const ctxWarning = getContextWarning(totalTurns);
  if (ctxWarning) noteParts.push(ctxWarning);

  return noteParts.join(' | ');
}

/**
 * 执行 Claude 任务的共享逻辑
 *
 * @param onTaskReady - 任务启动后的回调，传入可变的 TaskRunState 对象供调用方存入 runningTasks
 * @param onFirstContent - 首次收到内容时的回调（可选，飞书用来清除 waitingTimer）
 */
export function runClaudeTask(
  config: Config,
  sessionManager: SessionManager,
  ctx: TaskContext,
  prompt: string,
  adapter: TaskAdapter,
  userCosts: Map<string, CostRecord>,
  onTaskReady: (state: TaskRunState) => void,
  onFirstContent?: () => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let lastUpdateTime = 0;
    let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let firstContentLogged = false;
    let wasThinking = false;
    let thinkingText = '';
    let toolLines: string[] = [];
    const startTime = Date.now();

    // 任务状态对象（可变引用，调用方通过 onTaskReady 存入 runningTasks）
    let taskState: TaskRunState;

    const cleanup = () => {
      if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }
      adapter.extraCleanup?.();
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const throttledUpdate = (content: string) => {
      taskState.latestContent = content;

      const now = Date.now();
      const elapsed = now - lastUpdateTime;

      if (elapsed >= adapter.throttleMs) {
        lastUpdateTime = now;
        if (pendingUpdate) {
          clearTimeout(pendingUpdate);
          pendingUpdate = null;
        }
        const toolNote = toolLines.length > 0 ? toolLines.slice(-3).join('\n') : undefined;
        adapter.streamUpdate(taskState.latestContent, toolNote);
      } else if (!pendingUpdate) {
        pendingUpdate = setTimeout(() => {
          pendingUpdate = null;
          lastUpdateTime = Date.now();
          const toolNote = toolLines.length > 0 ? toolLines.slice(-3).join('\n') : undefined;
          adapter.streamUpdate(taskState.latestContent, toolNote);
        }, adapter.throttleMs - elapsed);
      }
    };

    const handle = runClaude(config.claudeCliPath, prompt, ctx.sessionId, ctx.workDir, {
      onSessionId: (id) => {
        if (ctx.threadId) {
          sessionManager.setSessionIdForThread(ctx.userId, ctx.threadId, id);
          log.info(`Session created for user ${ctx.userId}, thread=${ctx.threadId}: ${id}`);
        } else if (ctx.convId) {
          sessionManager.setSessionIdForConv(ctx.userId, ctx.convId, id);
          log.info(`Session created for user ${ctx.userId}, convId=${ctx.convId}: ${id}`);
        }
      },
      onThinking: (thinking) => {
        if (!firstContentLogged) {
          firstContentLogged = true;
          log.debug(`First content (thinking) for user ${ctx.userId} after ${Date.now() - startTime}ms`);
          onFirstContent?.();
        }
        wasThinking = true;
        thinkingText = thinking;
        const display = `💭 **思考中...**\n\n${thinking}`;
        throttledUpdate(display);
      },
      onText: (accumulated) => {
        if (!firstContentLogged) {
          firstContentLogged = true;
          log.debug(`First content (text) for user ${ctx.userId} after ${Date.now() - startTime}ms`);
          onFirstContent?.();
        }
        if (wasThinking && adapter.onThinkingToText) {
          wasThinking = false;
          if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = null;
          }
          lastUpdateTime = Date.now();
          taskState.latestContent = accumulated;
          adapter.onThinkingToText(accumulated);
          return;
        }
        wasThinking = false;
        throttledUpdate(accumulated);
      },
      onToolUse: (toolName, toolInput) => {
        const notification = formatToolCallNotification(toolName, toolInput);
        toolLines.push(notification);
        if (toolLines.length > 5) toolLines = toolLines.slice(-5);
        throttledUpdate(taskState.latestContent);
      },
      onComplete: async (result) => {
        if (settled) return;
        settled = true;

        // 先清除 pending 的节流定时器，防止它在 sendComplete 期间触发
        // 导致 streaming 更新覆盖 done 状态
        if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }

        const note = buildCompletionNote(result, sessionManager, ctx);
        log.info(`Claude completed for user ${ctx.userId}: success=${result.success}, cost=$${result.cost.toFixed(4)}`);
        trackCost(userCosts, ctx.userId, result.cost, result.durationMs);

        const finalContent = result.accumulated || result.result || '(无输出)';
        try {
          await adapter.sendComplete(finalContent, note, thinkingText || undefined);
        } catch (err) {
          log.error('Failed to send complete:', err);
        }
        cleanup();
        resolve();
      },
      onError: async (error) => {
        if (settled) return;
        settled = true;

        if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }

        log.error(`Claude error for user ${ctx.userId}, sessionId=${ctx.sessionId ?? 'new'}: ${error}`);
        try {
          await adapter.sendError(error);
        } catch (err) {
          log.error('Failed to send error:', err);
        }
        cleanup();
        resolve();
      },
    }, {
      skipPermissions: config.claudeSkipPermissions,
      timeoutMs: config.claudeTimeoutMs,
      model: sessionManager.getModel(ctx.userId, ctx.threadId) ?? config.claudeModel,
      chatId: ctx.chatId,
      hookPort: config.hookPort,
      threadRootMsgId: ctx.threadRootMsgId,
      threadId: ctx.threadId,
      platform: ctx.platform,
    });

    taskState = { handle, latestContent: '', settle, startedAt: Date.now() };
    onTaskReady(taskState);
  });
}
