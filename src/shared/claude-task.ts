/**
 * 共享的 Claude 任务执行逻辑
 * 封装各平台重复的节流更新、完成统计、竞态保护等代码
 */

import { access } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import type { Config } from '../config.js';
import type { SessionManager } from '../session/session-manager.js';
import { getAgentRuntime } from '../agent/runtime.js';
import type { AgentRunHandle } from '../agent/types.js';
import type { ParsedResult } from '../claude/stream-parser.js';
import type { CostRecord } from './types.js';
import { formatToolStats, formatToolCallNotification, trackCost, getContextWarning } from './utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('AgentTask');

/**
 * 任务执行器依赖项 — 服务级单例，由调用方注入
 */
export interface TaskDeps {
  config: Config;
  sessionManager: SessionManager;
  userCosts: Map<string, CostRecord>;
}

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
  /** 思考→文本切换处理（飞书 CardKit 需要重置基线，企业微信需要思考摘要） */
  onThinkingToText?(content: string, thinkingText: string): void;
  /** 额外清理逻辑（停止 typing 循环、清理 waitingTimer 等） */
  extraCleanup?(): void;
  /** 节流间隔（飞书 80ms，Telegram 200ms） */
  throttleMs: number;
  /** 任务启动后的回调，传入可变的 TaskRunState 对象供调用方存入 runningTasks */
  onTaskReady(state: TaskRunState): void;
  /** 首次收到内容时的回调（可选，飞书用来���除 waitingTimer） */
  onFirstContent?(): void;
  /** 发送图片消息（可选，用于截图自动发送） */
  sendImage?(imagePath: string): Promise<void>;
}

/**
 * 检测工具名是否为截图工具
 */
export function isScreenshotTool(toolName: string): boolean {
  return toolName.toLowerCase().includes('screenshot');
}

/**
 * 从工具输入中提取截图文件路径
 */
export function extractScreenshotPath(toolInput: Record<string, unknown>): string | undefined {
  for (const key of ['filePath', 'file_path', 'filename', 'path']) {
    const val = toolInput[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }
  return undefined;
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
  handle: AgentRunHandle;
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
 */
export function runClaudeTask(
  deps: TaskDeps,
  ctx: TaskContext,
  prompt: string,
  adapter: TaskAdapter,
): Promise<void> {
  const { config, sessionManager, userCosts } = deps;
  const runtime = getAgentRuntime(config.agentProvider);
  return new Promise<void>((resolve) => {
    let lastUpdateTime = 0;
    let pendingUpdate: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let firstContentLogged = false;
    let wasThinking = false;
    let thinkingText = '';
    let toolLines: string[] = [];
    const startTime = Date.now();
    const screenshotPaths: string[] = [];
    let lastActivityTime = startTime;
    let stallLogTimer: ReturnType<typeof setInterval> | null = null;

    // 任务状态对象（可变引用，调用方通过 onTaskReady 存入 runningTasks）
    let taskState: TaskRunState;

    const cleanup = () => {
      if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }
      if (stallLogTimer) { clearInterval(stallLogTimer); stallLogTimer = null; }
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

    const handle = runtime.run({
      provider: config.agentProvider,
      cliPath: config.agentCliPath,
      prompt,
      sessionId: ctx.sessionId,
      workDir: ctx.workDir,
      skipPermissions: config.agentSkipPermissions,
      timeoutMs: config.agentTimeoutMs,
      model: sessionManager.getModel(ctx.userId, ctx.threadId) ?? config.agentModel,
      chatId: ctx.chatId,
      hookPort: config.hookPort,
      threadRootMsgId: ctx.threadRootMsgId,
      threadId: ctx.threadId,
      platform: ctx.platform,
      proxyUrl: config.proxyUrl,
      codexSandbox: config.codexSandbox,
      codexApprovalPolicy: config.codexApprovalPolicy,
    }, {
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
        lastActivityTime = Date.now();
        if (!firstContentLogged) {
          firstContentLogged = true;
          log.info(`First content (thinking) for user ${ctx.userId} after ${Date.now() - startTime}ms`);
          adapter.onFirstContent?.();
        }
        wasThinking = true;
        thinkingText = thinking;
        const display = `💭 **思考中...**\n\n${thinking}`;
        throttledUpdate(display);
      },
      onText: (accumulated) => {
        lastActivityTime = Date.now();
        if (!firstContentLogged) {
          firstContentLogged = true;
          log.info(`First content (text) for user ${ctx.userId} after ${Date.now() - startTime}ms`);
          adapter.onFirstContent?.();
        }
        if (wasThinking && adapter.onThinkingToText) {
          wasThinking = false;
          if (pendingUpdate) {
            clearTimeout(pendingUpdate);
            pendingUpdate = null;
          }
          lastUpdateTime = Date.now();
          taskState.latestContent = accumulated;
          adapter.onThinkingToText(accumulated, thinkingText);
          return;
        }
        wasThinking = false;
        throttledUpdate(accumulated);
      },
      onToolUse: (toolName, toolInput) => {
        lastActivityTime = Date.now();
        const notification = formatToolCallNotification(toolName, toolInput);
        toolLines.push(notification);
        if (toolLines.length > 5) toolLines = toolLines.slice(-5);
        throttledUpdate(taskState.latestContent);

        // 收集截图路径
        if (isScreenshotTool(toolName) && toolInput) {
          const rawPath = extractScreenshotPath(toolInput);
          if (rawPath) {
            const absPath = rawPath.startsWith('/') ? rawPath : pathResolve(ctx.workDir, rawPath);
            if (!screenshotPaths.includes(absPath)) {
              screenshotPaths.push(absPath);
            }
          }
        }
      },
      onComplete: async (result) => {
        if (settled) return;
        settled = true;

        // 先清除 pending 的节流定时器，防止它在 sendComplete 期间触发
        // 导致 streaming 更新覆盖 done 状态
        if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }

        const note = buildCompletionNote(result, sessionManager, ctx);
        log.info(`${config.agentProvider} completed for user ${ctx.userId}: success=${result.success}, cost=$${result.cost.toFixed(4)}`);
        trackCost(userCosts, ctx.userId, result.cost, result.durationMs);

        const finalContent = result.accumulated || result.result || '(无输出)';
        try {
          await adapter.sendComplete(finalContent, note, thinkingText || undefined);
        } catch (err) {
          log.error('Failed to send complete:', err);
        }

        // 完成后自动发送截图
        if (adapter.sendImage && screenshotPaths.length > 0) {
          for (const imgPath of screenshotPaths) {
            try {
              await access(imgPath);
              await adapter.sendImage(imgPath);
            } catch (err) {
              log.warn(`Screenshot send skipped (${imgPath}):`, err);
            }
          }
        }

        cleanup();
        resolve();
      },
      onError: async (error) => {
        if (settled) return;
        settled = true;

        if (pendingUpdate) { clearTimeout(pendingUpdate); pendingUpdate = null; }

        log.error(`${config.agentProvider} error for user ${ctx.userId}, sessionId=${ctx.sessionId ?? 'new'}: ${error}`);
        try {
          await adapter.sendError(error);
        } catch (err) {
          log.error('Failed to send error:', err);
        }
        cleanup();
        resolve();
      },
    });

    taskState = { handle, latestContent: '', settle, startedAt: Date.now() };
    adapter.onTaskReady(taskState);

    // 定期检查任务活跃度，长时间无活动时输出日志
    stallLogTimer = setInterval(() => {
      if (settled) return;
      const now = Date.now();
      const totalElapsed = Math.floor((now - startTime) / 1000);
      const stallSeconds = Math.floor((now - lastActivityTime) / 1000);
      if (!firstContentLogged) {
        log.warn(`Task for user ${ctx.userId} waiting for first response... (${totalElapsed}s elapsed)`);
      } else if (stallSeconds >= 30) {
        log.info(`Task for user ${ctx.userId} running ${totalElapsed}s total, no output for ${stallSeconds}s (likely tool execution)`);
      }
    }, 60_000);
    (stallLogTimer as NodeJS.Timeout).unref();
  });
}
