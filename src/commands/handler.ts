import type { Config } from '../config.js';
import { saveRuntimeConfig } from '../config.js';
import type { SessionManager } from '../session/session-manager.js';
import type { RequestQueue } from '../queue/request-queue.js';
import { resolveLatestPermission, getPendingCount, listPending } from '../hook/permission-server.js';
import { TERMINAL_ONLY_COMMANDS } from '../constants.js';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ThreadContext, CostRecord } from '../shared/types.js';

export type { ThreadContext, CostRecord };

/**
 * 平台无关的消息发送接口
 */
export interface MessageSender {
  sendTextReply(chatId: string, text: string, threadCtx?: ThreadContext): Promise<void>;
}

/**
 * 命令处理器依赖项
 */
export interface CommandHandlerDeps {
  config: Config;
  sessionManager: SessionManager;
  requestQueue: RequestQueue;
  sender: MessageSender;
  userCosts: Map<string, CostRecord>;
  runningTasksSize: number;
}

/**
 * Claude 请求处理器类型
 */
export type ClaudeRequestHandler = (
  config: Config,
  sessionManager: SessionManager,
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

  /**
   * 更新运行中的任务数量
   */
  updateRunningTasksSize(size: number): void {
    this.deps.runningTasksSize = size;
  }

  /**
   * 统一命令分发：识别并处理所有命令，返回 true 表示已处理
   */
  async dispatch(
    text: string,
    chatId: string,
    userId: string,
    platform: 'feishu' | 'telegram',
    handleClaudeRequest: ClaudeRequestHandler,
    threadCtx?: ThreadContext,
  ): Promise<boolean> {
    const trimmed = text.trim();

    // 平台特有命令
    if (platform === 'telegram' && trimmed === '/start') {
      await this.deps.sender.sendTextReply(chatId, '欢迎使用 Claude Code Bot!\n\n发送消息与 Claude Code 交互，输入 /help 查看帮助。');
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
    if (trimmed === '/todos') return this.handleTodos(chatId, userId, handleClaudeRequest, threadCtx);
    if (trimmed === '/allow' || trimmed === '/y') return this.handleAllow(chatId, threadCtx);
    if (trimmed === '/deny' || trimmed === '/n') return this.handleDeny(chatId, threadCtx);
    if (trimmed === '/allowall') return this.handleAllowAll(chatId, threadCtx);
    if (trimmed === '/pending') return this.handlePending(chatId, threadCtx);

    // 带可选参数的命令
    if (trimmed === '/cd' || trimmed.startsWith('/cd ')) {
      return this.handleCd(chatId, userId, trimmed.slice(3).trim(), threadCtx);
    }
    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      return this.handleModel(chatId, trimmed.slice(6).trim(), threadCtx);
    }
    if (trimmed === '/compact' || trimmed.startsWith('/compact ')) {
      return this.handleCompact(chatId, userId, trimmed.slice(8).trim(), handleClaudeRequest, threadCtx);
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
  async handleHelp(chatId: string, platform: 'feishu' | 'telegram', threadCtx?: ThreadContext): Promise<boolean> {
    const startCmd = platform === 'telegram' ? '/start           - 显示欢迎信息\n' : '';
    const threadsCmd = platform === 'feishu' ? '/threads        - 列出所有话题会话\n' : '';
    const helpText = [
      '📋 可用命令:',
      '',
      startCmd,
      '/help           - 显示此帮助信息',
      '/new            - 开始新会话',
      '/compact [说明]  - 压缩对话上下文（节省 token）',
      '/cost           - 显示本次会话费用统计',
      '/status         - 显示 Claude Code 状态信息',
      '/model [模型名]  - 查看或切换模型',
      '/doctor         - 检查 Claude Code 健康状态',
      '/cd <路径>      - 切换工作目录',
      '/pwd            - 查看当前工作目录',
      '/list           - 列出所有工作区',
      '/todos          - 列出当前 TODO 项',
      threadsCmd,
      '/allow (/y)     - 允许权限请求',
      '/deny (/n)      - 拒绝权限请求',
      '/allowall       - 批量允许所有待确认权限',
      '/pending        - 查看待确认权限列表',
    ].filter(Boolean).join('\n');

    await this.deps.sender.sendTextReply(chatId, helpText, threadCtx);
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
    const dir = args.trim();
    if (!dir) {
      const workDir = threadCtx
        ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
        : this.deps.sessionManager.getWorkDir(userId);
      await this.deps.sender.sendTextReply(chatId, `当前工作目录: ${workDir}`, threadCtx);
      return true;
    }
    try {
      const resolved = threadCtx
        ? await this.deps.sessionManager.setWorkDirForThread(userId, threadCtx.threadId, dir, threadCtx.rootMessageId)
        : await this.deps.sessionManager.setWorkDir(userId, dir);
      await this.deps.sender.sendTextReply(chatId, `工作目录已切换到: ${resolved}\n会话已重置。`, threadCtx);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.sender.sendTextReply(chatId, message, threadCtx);
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
      await this.deps.sender.sendTextReply(chatId, '未找到 Claude Code 工作区记录。', threadCtx);
    } else {
      const current = threadCtx
        ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
        : this.deps.sessionManager.getWorkDir(userId);
      const lines = dirs.map((d) => (d === current ? `▶ ${d}` : `  ${d}`));
      await this.deps.sender.sendTextReply(chatId, `Claude Code 工作区列表:\n${lines.join('\n')}\n\n使用 /cd <路径> 切换`, threadCtx);
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
      '📊 Claude Code 状态:',
      '',
      `版本: ${version}`,
      `工作目录: ${workDir}`,
      `会话 ID: ${sessionId ?? '（无）'}`,
      `跳过权限: ${this.deps.config.claudeSkipPermissions ? '是' : '否'}`,
      `超时设置: ${this.deps.config.claudeTimeoutMs / 1000}s`,
      `累计费用: $${record?.totalCost.toFixed(4) ?? '0.0000'}`,
    ];
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
  async handleModel(chatId: string, args: string, threadCtx?: ThreadContext): Promise<boolean> {
    const modelArg = args.trim();
    if (!modelArg) {
      await this.deps.sender.sendTextReply(
        chatId,
        `当前模型: ${this.deps.config.claudeModel ?? '默认 (由 Claude Code 决定)'}\n\n可选模型: sonnet, opus, haiku 或完整模型名\n用法: /model <模型名>`,
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
      this.deps.config.claudeModel = modelArg;
      saveRuntimeConfig(this.deps.config);
      await this.deps.sender.sendTextReply(chatId, `模型已切换为: ${modelArg}\n后续对话将使用此模型。`, threadCtx);
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
      '🏥 Claude Code 健康检查:',
      '',
      `CLI 路径: ${this.deps.config.claudeCliPath}`,
      `版本: ${version}`,
      `工作目录: ${workDir}`,
      `允许的基础目录: ${this.deps.config.allowedBaseDirs.join(', ')}`,
      `活跃任务数: ${this.deps.runningTasksSize}`,
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
      await handleClaudeRequest(this.deps.config, this.deps.sessionManager, userId, chatId, prompt, workDir, undefined, threadCtx);
    });
    if (enqueueResult === 'rejected') {
      await this.deps.sender.sendTextReply(chatId, '请求队列已满，请等待当前任务完成后再试。', threadCtx);
    } else if (enqueueResult === 'queued') {
      await this.deps.sender.sendTextReply(chatId, '前面还有任务在处理中，压缩请求已排队等待。', threadCtx);
    }
    return true;
  }

  /**
   * 处理 /todos 命令
   */
  async handleTodos(
    chatId: string,
    userId: string,
    handleClaudeRequest: ClaudeRequestHandler,
    threadCtx?: ThreadContext,
  ): Promise<boolean> {
    const workDir = threadCtx
      ? this.deps.sessionManager.getWorkDirForThread(userId, threadCtx.threadId)
      : this.deps.sessionManager.getWorkDir(userId);
    const queueKey = threadCtx ? threadCtx.threadId : this.deps.sessionManager.getConvId(userId);
    const todosPrompt = '请列出当前项目中所有的 TODO 项（检查代码中的 TODO、FIXME、HACK 注释）。';
    const enqueueResult = this.deps.requestQueue.enqueue(userId, queueKey, todosPrompt, async (prompt) => {
      await handleClaudeRequest(this.deps.config, this.deps.sessionManager, userId, chatId, prompt, workDir, undefined, threadCtx);
    });
    if (enqueueResult === 'rejected') {
      await this.deps.sender.sendTextReply(chatId, '请求队列已满，请等待当前任务完成后再试。', threadCtx);
    } else if (enqueueResult === 'queued') {
      await this.deps.sender.sendTextReply(chatId, '前面还有任务在处理中，请求已排队等待。', threadCtx);
    }
    return true;
  }

  /**
   * 处理 /allow 或 /y 命令
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
   * 处理 /deny 或 /n 命令
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
   * 处理 /allowall 命令
   */
  async handleAllowAll(chatId: string, threadCtx?: ThreadContext): Promise<boolean> {
    let count = 0;
    while (resolveLatestPermission(chatId, 'allow')) {
      count++;
    }
    if (count > 0) {
      await this.deps.sender.sendTextReply(chatId, `✅ 已批量允许 ${count} 个权限请求`, threadCtx);
    } else {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求', threadCtx);
    }
    return true;
  }

  /**
   * 处理 /pending 命令
   */
  async handlePending(chatId: string, threadCtx?: ThreadContext): Promise<boolean> {
    const pending = listPending(chatId);
    if (pending.length === 0) {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求', threadCtx);
    } else {
      const list = pending.map((p: { toolName: string; id: string }, i: number) => `${i + 1}. ${p.toolName} (ID: ${p.id})`).join('\n');
      await this.deps.sender.sendTextReply(chatId, `🔐 待确认权限列表:\n\n${list}\n\n使用 /allow 允许最早的请求`, threadCtx);
    }
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
      execFile(this.deps.config.claudeCliPath, ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          resolve('未知');
        } else {
          resolve(stdout.trim() || '未知');
        }
      });
    });
  }
}
