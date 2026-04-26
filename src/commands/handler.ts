import type { Config, Platform } from '../config.js';
import type { SessionManager } from '../session/session-manager.js';
import type { RequestQueue } from '../queue/request-queue.js';
import { resolveLatestPermission, getPendingCount } from '../hook/permission-server.js';
import { TERMINAL_ONLY_COMMANDS } from '../constants.js';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ThreadContext, CostRecord, MessageSender } from '../shared/types.js';
import { getHistory, formatHistoryPage, getSessionList, formatSessionList } from '../shared/history.js';
import { registerWatch, unregisterWatch, getWatchStatus, muteSession, unmuteSession, type WatchLevel } from '../hook/watch.js';

export type { ThreadContext, CostRecord, MessageSender };

/**
 * 命令处理器依赖项
 */
export interface CommandHandlerDeps {
  config: Config;
  sessionManager: SessionManager;
  requestQueue: RequestQueue;
  sender: MessageSender;
  userCosts: Map<string, CostRecord>;
  getRunningTasksSize: () => number;
}

/**
 * Claude 请求处理器类型
 */
export type ClaudeRequestHandler = (
  userId: string,
  chatId: string,
  prompt: string,
  workDir: string,
  convId?: string,
  threadCtx?: ThreadContext,
) => Promise<void>;

/**
 * 共享的命令处理器
 */
export class CommandHandler {
  constructor(private deps: CommandHandlerDeps) {}

  private getAgentLabel(): string {
    return this.deps.config.agentProvider === 'codex'
      ? 'Codex'
      : this.deps.config.agentProvider === 'opencode'
        ? 'OpenCode'
        : 'Claude Code';
  }

  private supportsLocalHistory(): boolean {
    return this.deps.config.agentProvider === 'claude' || this.deps.config.agentProvider === 'codex';
  }

  /**
   * 统一命令分发：识别并处理所有命令，返回 true 表示已处理
   */
  async dispatch(
    text: string,
    chatId: string,
    userId: string,
    platform: Platform,
    handleClaudeRequest: ClaudeRequestHandler,
    threadCtx?: ThreadContext,
  ): Promise<boolean> {
    const trimmed = text.trim();

    // 平台特有命令
    if (platform === 'telegram' && trimmed === '/start') {
      const label = this.getAgentLabel();
      await this.deps.sender.sendTextReply(chatId, `欢迎使用 ${label} Bot!\n\n发送消息与 ${label} 交互，输入 /help 查看帮助。`);
      return true;
    }
    if (platform === 'feishu' && trimmed === '/threads') {
      return this.handleThreads(chatId, userId, threadCtx);
    }

    // 无参数命令
    if (trimmed === '/help') return this.handleHelp(chatId, platform, threadCtx);
    if (trimmed === '/new') return this.handleNew(chatId, userId, threadCtx);
    if (trimmed === '/pwd') return this.handlePwd(chatId, userId, threadCtx);
    if (trimmed === '/list') return this.handleList(chatId, userId, threadCtx);
    if (trimmed === '/cost') return this.handleCost(chatId, userId, threadCtx);
    if (trimmed === '/status') return this.handleStatus(chatId, userId, threadCtx);
    if (trimmed === '/doctor') return this.handleDoctor(chatId, userId, threadCtx);
    if (trimmed === '/allow' || trimmed === '/y') return this.handleAllow(chatId, threadCtx);
    if (trimmed === '/deny' || trimmed === '/n') return this.handleDeny(chatId, threadCtx);
    // 带可选参数的命令
    if (trimmed === '/cd' || trimmed.startsWith('/cd ')) {
      return this.handleCd(chatId, userId, trimmed.slice(3).trim(), threadCtx);
    }
    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      return this.handleModel(chatId, userId, trimmed.slice(6).trim(), threadCtx);
    }
    if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
      return this.handleCompact(chatId, userId, trimmed.slice(8).trim(), handleClaudeRequest, threadCtx);
    }
    if (trimmed === '/history' || trimmed.startsWith('/history ')) {
      return this.handleHistory(chatId, userId, trimmed.slice(8).trim(), threadCtx);
    }
    if (trimmed === '/resume' || trimmed.startsWith('/resume ')) {
      return this.handleResume(chatId, userId, trimmed.slice(7).trim(), threadCtx);
    }
    if (trimmed === '/watch' || trimmed.startsWith('/watch ')) {
      return this.handleWatch(chatId, userId, trimmed.slice(6).trim(), platform, threadCtx);
    }

    // 仅终端可用的命令
    const cmdName = trimmed.split(/\s+/)[0];
    if (TERMINAL_ONLY_COMMANDS.has(cmdName)) {
      await this.deps.sender.sendTextReply(
        chatId,
        `${cmdName} 命令仅在终端交互模式下可用。\n\n输入 /help 查看可用命令。`,
        threadCtx,
      );
      return true;
    }

    return false;
  }

  /**
   * 处理 /help 命令
   */
  async handleHelp(chatId: string, platform: Platform, threadCtx?: ThreadContext): Promise<boolean> {
    const lines: string[] = ['📋 可用命令:'];

    // 会话管理
    lines.push('', '💬 会话管理:');
    lines.push('/new            - 开始新会话');
    lines.push('/compact [说明]  - 压缩对话上下文（节省 token）');
    lines.push('/history [页码]  - 查看当前会话聊天记录');
    lines.push('/resume [序号]   - 浏览/恢复历史会话');

    // 工作区
    lines.push('', '📁 工作区:');
    lines.push('/cd <路径>      - 切换工作目录');
    lines.push('/pwd            - 查看当前工作目录');
    lines.push('/list           - 列出所有工作区');

    // 监控与诊断
    lines.push('', '📊 监控与诊断:');
    lines.push('/status         - 显示当前 Agent 状态信息');
    lines.push('/cost           - 显示本次会话费用统计');
    lines.push('/doctor         - 检查当前 Agent 健康状态');
    lines.push('/watch [级别]   - 监控终端 Agent 状态');

    // 高级
    lines.push('', '⚙️  高级:');
    lines.push('/model [模型名]  - 查看或切换模型');
    lines.push('/allow (/y)     - 允许权限请求');
    lines.push('/deny (/n)      - 拒绝权限请求');

    // 平台特有
    if (platform === 'telegram') lines.push('/start           - 显示欢迎信息');
    if (platform === 'feishu') lines.push('/threads        - 列出所有话题会话');
    if (platform === 'wecom') lines.push('/stop           - 停止当前运行的任务');

    await this.deps.sender.sendTextReply(chatId, lines.join('\n'), threadCtx);
    return true;
  }

  /**
   * 处理 /new 命令 - 开始新会话
   */
  async handleNew(chatId: string, userId: string, threadCtx?: ThreadContext): Promise<boolean> {
    if (threadCtx) {
      const success = this.deps.sessionManager.newThreadSession(userId, threadCtx.threadId);
      if (success) {
        await this.deps.sender.sendTextReply(chatId, '✅ 已开始新会话，之前的上下文不会延续。', threadCtx);
      } else {
        await this.deps.sender.sendTextReply(chatId, '当前话题没有活动会话。', threadCtx);
      }
    } else {
      const created = this.deps.sessionManager.newSession(userId);
      if (created) {
        await this.deps.sender.sendTextReply(chatId, '✅ 已开始新会话，之前的上下文不会延续。', threadCtx);
      } else {
        await this.deps.sender.sendTextReply(chatId, '当前没有活动会话。', threadCtx);
      }
    }
    return true;
  }

  /**
   * 处理 /cd 命令
   */
  async handleCd(chatId: string, userId: string, args: string, threadCtx?: ThreadContext): Promise<boolean> {
    let dir = args.trim();
    if (!dir) {
      const workDir = threadCtx
        ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
        : this.deps.sessionManager.getWorkDir(userId);
      const subdirs = await this.listSubDirs(workDir);
      const lines = [`当前工作目录: ${workDir}`];
      if (subdirs.length > 0) {
        const countNote = subdirs.length >= 30 ? '（仅显示前 30 个）' : '';
        lines.push('', `📁 子目录${countNote}:`, ...subdirs.map(d => `  ${d}/`));
        lines.push('', '使用 /cd <目录名> 切换');
      }
      await this.deps.sender.sendTextReply(chatId, lines.join('\n'), threadCtx);
      return true;
    }
    // 支持通过序号切换（对应 /list 的编号）
    if (/^\d+$/.test(dir)) {
      const index = parseInt(dir, 10) - 1;
      const dirs = this.listClaudeProjects();
      if (index < 0 || index >= dirs.length) {
        await this.deps.sender.sendTextReply(chatId, `无效的序号 ${dir}，请使用 /list 查看可用工作区。`, threadCtx);
        return true;
      }
      dir = dirs[index];
    }
    try {
      const resolved = threadCtx
        ? await this.deps.sessionManager.setWorkDirForThread(userId, threadCtx.threadId, dir, threadCtx.rootMessageId)
        : await this.deps.sessionManager.setWorkDir(userId, dir);
      await this.deps.sender.sendTextReply(chatId, `工作目录已切换到: ${resolved}\n会话已重置。`, threadCtx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.sender.sendTextReply(chatId, `❌ 目录切换失败: ${message}`, threadCtx);
    }
    return true;
  }

  /**
   * 处理 /pwd 命令
   */
  async handlePwd(chatId: string, userId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    await this.deps.sender.sendTextReply(chatId, `当前工作目录: ${workDir}`, threadCtx);
    return true;
  }

  /**
   * 处理 /list 命令
   */
  async handleList(chatId: string, userId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const dirs = this.listClaudeProjects();
    if (dirs.length === 0) {
      await this.deps.sender.sendTextReply(chatId, `未找到 ${this.getAgentLabel()} 工作区记录。`, threadCtx);
    } else {
      const current = threadCtx
        ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
        : this.deps.sessionManager.getWorkDir(userId);
      const lines = dirs.map((d, i) => (d === current ? `${i + 1}. ▶ ${d}` : `${i + 1}. ${d}`));
      await this.deps.sender.sendTextReply(chatId, `${this.getAgentLabel()} 工作区列表:\n${lines.join('\n')}\n\n使用 /cd <序号> 或 /cd <路径> 切换`, threadCtx);
    }
    return true;
  }

  /**
   * 处理 /cost 命令
   */
  async handleCost(chatId: string, userId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const record = this.deps.userCosts.get(userId);
    if (!record || record.requestCount === 0) {
      await this.deps.sender.sendTextReply(chatId, '暂无费用记录（本次服务启动后）。', threadCtx);
    } else {
      const lines = [
        '💰 费用统计（本次服务启动后）:',
        '',
        `请求次数: ${record.requestCount}`,
        `总费用: $${record.totalCost.toFixed(4)}`,
        `总耗时: ${(record.totalDurationMs / 1000).toFixed(1)}s`,
        `平均每次: $${(record.totalCost / record.requestCount).toFixed(4)}`,
      ];
      await this.deps.sender.sendTextReply(chatId, lines.join('\n'), threadCtx);
    }
    return true;
  }

  /**
   * 处理 /status 命令
   */
  async handleStatus(chatId: string, userId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const version = await this.getClaudeVersion();
    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    const sessionId = threadCtx
      ? this.deps.sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getSessionIdForConv(userId, this.deps.sessionManager.getConvId(userId));
    const record = this.deps.userCosts.get(userId);
    const lines = [
      `📊 ${this.getAgentLabel()} 状态:`,
      '',
      `Runtime: ${this.deps.config.agentProvider}`,
      `版本: ${version}`,
      `工作目录: ${workDir}`,
      `会话 ID: ${sessionId ?? '（无）'}`,
      `跳过权限: ${this.deps.config.agentSkipPermissions ? '是' : '否'}`,
      `超时设置: ${this.deps.config.agentTimeoutMs / 1000}s`,
      `累计费用: $${record?.totalCost.toFixed(4) ?? '0.0000'}`,
    ];
    if (this.deps.config.agentProvider === 'codex') {
      lines.splice(6, 0, `Sandbox: ${this.deps.config.codexSandbox}`);
      lines.splice(7, 0, `审批策略: ${this.deps.config.codexApprovalPolicy}`);
    }
    await this.deps.sender.sendTextReply(chatId, lines.join('\n'), threadCtx);
    return true;
  }

  /**
   * 验证模型名称是否合法
   */
  private isValidModelName(name: string): boolean {
    // 允许字母、数字、点、连字符、斜杠，最长 100 字符
    // 不允许连续斜杠、开头/结尾斜杠
    if (!/^[a-zA-Z0-9.\-/]{1,100}$/.test(name)) return false;
    if (name.includes('//')) return false;
    if (name.startsWith('/') || name.endsWith('/')) return false;
    return true;
  }

  /**
   * 处理 /model 命令
   */
  async handleModel(chatId: string, userId: string, args: string, threadCtx?: ThreadContext): Promise<boolean> {
    const modelArg = args.trim();
    const threadId = threadCtx?.threadId;
    if (!modelArg) {
      const currentModel = this.deps.sessionManager.getModel(userId, threadId);
      const scope = threadId ? '当前话题' : '当前';
      await this.deps.sender.sendTextReply(
        chatId,
        `${scope}模型: ${currentModel ?? this.deps.config.agentModel ?? `默认 (由 ${this.getAgentLabel()} 决定)`}\n\n用法: /model <模型名>`,
        threadCtx,
      );
    } else {
      if (!this.isValidModelName(modelArg)) {
        await this.deps.sender.sendTextReply(
          chatId,
          '❌ 无效的模型名称。模型名只能包含字母、数字、点、连字符和斜杠，且长度不超过 100 字符。',
          threadCtx,
        );
        return true;
      }
      this.deps.sessionManager.setModel(userId, modelArg, threadId);
      const scope = threadId ? '当前话题' : '';
      await this.deps.sender.sendTextReply(chatId, `${scope}模型已切换为: ${modelArg}\n后续对话将使用此模型。`, threadCtx);
    }
    return true;
  }

  /**
   * 处理 /doctor 命令
   */
  async handleDoctor(chatId: string, userId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const version = await this.getClaudeVersion();
    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    const lines = [
      `🏥 ${this.getAgentLabel()} 健康检查:`,
      '',
      `Runtime: ${this.deps.config.agentProvider}`,
      `CLI 路径: ${this.deps.config.agentCliPath}`,
      `版本: ${version}`,
      `工作目录: ${workDir}`,
      `允许的基础目录: ${this.deps.config.allowedBaseDirs.join(', ')}`,
      `活跃任务数: ${this.deps.getRunningTasksSize()}`,
    ];
    await this.deps.sender.sendTextReply(chatId, lines.join('\n'), threadCtx);
    return true;
  }

  /**
   * 处理 /compact 命令
   */
  async handleCompact(
    chatId: string,
    userId: string,
    args: string,
    handleClaudeRequest: ClaudeRequestHandler,
    threadCtx?: ThreadContext,
  ): Promise<boolean> {
    const sessionId = threadCtx
      ? this.deps.sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getSessionIdForConv(userId, this.deps.sessionManager.getConvId(userId));
    if (!sessionId) {
      await this.deps.sender.sendTextReply(chatId, '当前没有活动会话，无需压缩。', threadCtx);
      return true;
    }
    const instructions = args.trim();
    const compactPrompt = instructions
      ? `请压缩并总结之前的对话上下文，聚焦于: ${instructions}`
      : '请压缩并总结之前的对话上下文，保留关键信息。';

    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    const queueKey = threadCtx ? threadCtx.threadId : this.deps.sessionManager.getConvId(userId);
    const enqueueResult = this.deps.requestQueue.enqueue(userId, queueKey, compactPrompt, async (prompt) => {
      await handleClaudeRequest(userId, chatId, prompt, workDir, undefined, threadCtx);
    });
    if (enqueueResult.status === 'rejected') {
      await this.deps.sender.sendTextReply(chatId, `请求队列已满（${enqueueResult.queueSize}/${enqueueResult.queueSize}），请等待当前任务完成后再试。`, threadCtx);
    } else if (enqueueResult.status === 'queued') {
      await this.deps.sender.sendTextReply(chatId, `前面还有任务在处理中，压缩请求已排队（位置 ${enqueueResult.position}/${enqueueResult.queueSize}）。`, threadCtx);
    }
    return true;
  }


  /**
   * 处理 /allow 或 /y 命令（按钮不可用时的 fallback）
   */
  async handleAllow(chatId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const reqId = resolveLatestPermission(chatId, 'allow');
    if (reqId) {
      const remaining = getPendingCount(chatId);
      await this.deps.sender.sendTextReply(chatId, `✅ 权限已允许${remaining > 0 ? `（还有 ${remaining} 个待确认）` : ''}`, threadCtx);
    } else {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求', threadCtx);
    }
    return true;
  }

  /**
   * 处理 /deny 或 /n 命令（按钮不可用时的 fallback）
   */
  async handleDeny(chatId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const reqId = resolveLatestPermission(chatId, 'deny');
    if (reqId) {
      const remaining = getPendingCount(chatId);
      await this.deps.sender.sendTextReply(chatId, `❌ 权限已拒绝${remaining > 0 ? `（还有 ${remaining} 个待确认）` : ''}`, threadCtx);
    } else {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求', threadCtx);
    }
    return true;
  }

  /**
   * 处理 /history 命令 - 浏览会话历史
   */
  async handleHistory(chatId: string, userId: string, args: string, threadCtx?: ThreadContext): Promise<boolean> {
    if (!this.supportsLocalHistory()) {
      await this.deps.sender.sendTextReply(chatId, `当前 runtime (${this.deps.config.agentProvider}) 暂未实现 /history。`, threadCtx);
      return true;
    }
    const page = args ? (parseInt(args, 10) || 1) : 0;
    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    const sessionId = threadCtx
      ? this.deps.sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getSessionIdForConv(userId, this.deps.sessionManager.getConvId(userId));

    const result = await getHistory(workDir, sessionId, page, this.deps.config.agentProvider);
    if (!result.ok) {
      await this.deps.sender.sendTextReply(chatId, result.error, threadCtx);
    } else {
      await this.deps.sender.sendTextReply(chatId, formatHistoryPage(result.data), threadCtx);
    }
    return true;
  }

  /**
   * 处理 /resume 命令 - 浏览/恢复历史会话
   */
  async handleResume(chatId: string, userId: string, args: string, threadCtx?: ThreadContext): Promise<boolean> {
    if (!this.supportsLocalHistory()) {
      await this.deps.sender.sendTextReply(chatId, `当前 runtime (${this.deps.config.agentProvider}) 暂未实现 /resume。`, threadCtx);
      return true;
    }
    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    const currentSessionId = threadCtx
      ? this.deps.sessionManager.getSessionIdForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getSessionIdForConv(userId, this.deps.sessionManager.getConvId(userId));

    const listResult = await getSessionList(workDir, currentSessionId, this.deps.config.agentProvider);
    if (!listResult.ok) {
      await this.deps.sender.sendTextReply(chatId, listResult.error, threadCtx);
      return true;
    }

    if (!args) {
      await this.deps.sender.sendTextReply(chatId, formatSessionList(listResult.data), threadCtx);
      return true;
    }

    const index = parseInt(args, 10) - 1;
    if (Number.isNaN(index) || index < 0 || index >= listResult.data.length) {
      await this.deps.sender.sendTextReply(chatId, `无效的序号 ${args}，共 ${listResult.data.length} 个会话。`, threadCtx);
      return true;
    }

    const target = listResult.data[index];
    if (target.isCurrent) {
      await this.deps.sender.sendTextReply(chatId, '该会话已是当前会话。', threadCtx);
      return true;
    }

    this.deps.sessionManager.resumeSession(userId, target.sessionId);
    await this.deps.sender.sendTextReply(chatId, `已恢复会话: ${target.preview}\n后续消息将延续该会话上下文。`, threadCtx);
    return true;
  }

  /**
   * 处理 /watch 命令 - 监控终端 Agent 状态
   */
  async handleWatch(chatId: string, userId: string, args: string, platform: Platform, threadCtx?: ThreadContext): Promise<boolean> {
    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    const threadId = threadCtx?.threadId;

    if (!args) {
      const status = getWatchStatus(chatId, threadId);
      if (status) {
        const mutedList = status.mutedSessions?.size
          ? `\n屏蔽: ${[...status.mutedSessions].map(s => `[${s}]`).join(' ')}`
          : '';
        await this.deps.sender.sendTextReply(chatId, `📡 监控中 [${status.level}]\n工作区: ${status.workDir}${mutedList}`, threadCtx);
      } else {
        await this.deps.sender.sendTextReply(chatId, '📡 未开启监控\n\n使用 /watch <级别> 开启：\n  stop - 仅完成事件\n  tool - 工具调用 + 完成\n  full - 全量（含子代理）', threadCtx);
      }
      return true;
    }

    if (args === 'off') {
      unregisterWatch(workDir, chatId, threadId);
      await this.deps.sender.sendTextReply(chatId, '📡 已关闭监控', threadCtx);
      return true;
    }

    if (args.startsWith('mute ')) {
      const sid = args.slice(5).trim();
      if (!sid) {
        await this.deps.sender.sendTextReply(chatId, '请指定要屏蔽的会话 ID 后 4 位，如: /watch mute a1b2', threadCtx);
        return true;
      }
      if (muteSession(workDir, chatId, sid, threadId)) {
        await this.deps.sender.sendTextReply(chatId, `📡 已屏蔽会话 [${sid}]`, threadCtx);
      } else {
        await this.deps.sender.sendTextReply(chatId, '未找到活跃的监控，请先 /watch <级别> 开启。', threadCtx);
      }
      return true;
    }

    if (args.startsWith('unmute ')) {
      const sid = args.slice(7).trim();
      if (!sid) {
        await this.deps.sender.sendTextReply(chatId, '请指定要取消屏蔽的会话 ID，如: /watch unmute a1b2', threadCtx);
        return true;
      }
      if (unmuteSession(workDir, chatId, sid, threadId)) {
        await this.deps.sender.sendTextReply(chatId, `📡 已取消屏蔽会话 [${sid}]`, threadCtx);
      } else {
        await this.deps.sender.sendTextReply(chatId, '未找到该屏蔽记录。', threadCtx);
      }
      return true;
    }

    const validLevels: WatchLevel[] = ['stop', 'tool', 'full'];
    if (!validLevels.includes(args as WatchLevel)) {
      await this.deps.sender.sendTextReply(chatId, `无效的监控级别: ${args}\n可选: stop / tool / full / off / mute <id> / unmute <id>`, threadCtx);
      return true;
    }

    registerWatch(workDir, { chatId, platform, threadCtx, level: args as WatchLevel });
    await this.deps.sender.sendTextReply(chatId, `📡 已开启监控 [${args}]\n工作区: ${workDir}\n\n在此工作区启动的终端 ${this.getAgentLabel()} 事件将推送到此处。\n使用 /watch off 关闭`, threadCtx);
    return true;
  }

  /**
   * 处理 /threads 命令 - 列出所有话题会话
   */
  async handleThreads(chatId: string, userId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const threads = this.deps.sessionManager.listThreads(userId);
    if (threads.length === 0) {
      await this.deps.sender.sendTextReply(chatId, '暂无话题会话记录。', threadCtx);
    } else {
      const lines = threads.map((t, i) => {
        const sessionStatus = t.sessionId ? '✓' : '✗';
        const displayName = t.displayName || t.threadId.slice(-8);
        return `${i + 1}. ${displayName} [${sessionStatus}] - ${t.workDir}`;
      });
      await this.deps.sender.sendTextReply(
        chatId,
        `📋 话题会话列表 (${threads.length}):\n\n${lines.join('\n')}\n\n✓ = 有活跃会话 | ✗ = 无会话`,
        threadCtx,
      );
    }
    return true;
  }

  /**
   * 列出目录下的子目录（排除隐藏目录，最多30个）
   */
  private async listSubDirs(dir: string): Promise<string[]> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => d.name)
        .sort()
        .slice(0, 30);
    } catch { return []; }
  }

  /**
   * 列出 Claude 项目
   */
  private listClaudeProjects(): string[] {
    const configPath = join(homedir(), '.claude.json');
    try {
      const data = JSON.parse(readFileSync(configPath, 'utf-8'));
      const projects: Record<string, unknown> = data.projects ?? {};
      return Object.keys(projects)
        .filter((dir) => this.deps.config.allowedBaseDirs.some((base) => dir === base || dir.startsWith(base + '/')))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 获取 Claude 版本
   */
  private getClaudeVersion(): Promise<string> {
    return new Promise((resolve) => {
      execFile(this.deps.config.agentCliPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve('未知');
        } else {
          resolve(stdout.trim() || '未知');
        }
      });
    });
  }
}
