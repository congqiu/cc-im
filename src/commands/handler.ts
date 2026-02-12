import type { Config } from '../config.js';
import type { SessionManager } from '../session/session-manager.js';
import type { RequestQueue } from '../queue/request-queue.js';
import { resolveLatestPermission, getPendingCount, listPending } from '../hook/permission-server.js';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 平台无关的消息发送接口
 */
export interface MessageSender {
  sendTextReply(chatId: string, text: string): Promise<void>;
}

/**
 * 费用记录
 */
export interface CostRecord {
  totalCost: number;
  totalDurationMs: number;
  requestCount: number;
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
  convId: string,
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
   * 处理 /help 命令
   */
  async handleHelp(chatId: string, platform: 'feishu' | 'telegram'): Promise<boolean> {
    const startCmd = platform === 'telegram' ? '/start           - 显示欢迎信息\n' : '';
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
      '/allow (/y)     - 允许权限请求',
      '/deny (/n)      - 拒绝权限请求',
      '/allowall       - 批量允许所有待确认权限',
      '/pending        - 查看待确认权限列表',
    ].filter(Boolean).join('\n');

    await this.deps.sender.sendTextReply(chatId, helpText);
    return true;
  }

  /**
   * 处理 /new 命令 - 开始新会话
   */
  async handleNew(chatId: string, userId: string): Promise<boolean> {
    const created = this.deps.sessionManager.newSession(userId);
    if (created) {
      await this.deps.sender.sendTextReply(chatId, '✅ 已开始新会话，之前的上下文不会延续。');
    } else {
      await this.deps.sender.sendTextReply(chatId, '当前没有活动会话。');
    }
    return true;
  }

  /**
   * 处理 /cd 命令
   */
  async handleCd(chatId: string, userId: string, args: string): Promise<boolean> {
    const dir = args.trim();
    if (!dir) {
      await this.deps.sender.sendTextReply(chatId, `当前工作目录: ${this.deps.sessionManager.getWorkDir(userId)}`);
      return true;
    }
    try {
      const resolved = this.deps.sessionManager.setWorkDir(userId, dir);
      await this.deps.sender.sendTextReply(chatId, `工作目录已切换到: ${resolved}\n会话已重置。`);
    } catch (err: any) {
      await this.deps.sender.sendTextReply(chatId, err.message);
    }
    return true;
  }

  /**
   * 处理 /pwd 命令
   */
  async handlePwd(chatId: string, userId: string): Promise<boolean> {
    await this.deps.sender.sendTextReply(chatId, `当前工作目录: ${this.deps.sessionManager.getWorkDir(userId)}`);
    return true;
  }

  /**
   * 处理 /list 命令
   */
  async handleList(chatId: string, userId: string): Promise<boolean> {
    const dirs = this.listClaudeProjects();
    if (dirs.length === 0) {
      await this.deps.sender.sendTextReply(chatId, '未找到 Claude Code 工作区记录。');
    } else {
      const current = this.deps.sessionManager.getWorkDir(userId);
      const lines = dirs.map((d) => (d === current ? `▶ ${d}` : `  ${d}`));
      await this.deps.sender.sendTextReply(chatId, `Claude Code 工作区列表:\n${lines.join('\n')}\n\n使用 /cd <路径> 切换`);
    }
    return true;
  }

  /**
   * 处理 /cost 命令
   */
  async handleCost(chatId: string, userId: string): Promise<boolean> {
    const record = this.deps.userCosts.get(userId);
    if (!record || record.requestCount === 0) {
      await this.deps.sender.sendTextReply(chatId, '暂无费用记录（本次服务启动后）。');
    } else {
      const lines = [
        '💰 费用统计（本次服务启动后）:',
        '',
        `请求次数: ${record.requestCount}`,
        `总费用: $${record.totalCost.toFixed(4)}`,
        `总耗时: ${(record.totalDurationMs / 1000).toFixed(1)}s`,
        `平均每次: $${(record.totalCost / record.requestCount).toFixed(4)}`,
      ];
      await this.deps.sender.sendTextReply(chatId, lines.join('\n'));
    }
    return true;
  }

  /**
   * 处理 /status 命令
   */
  async handleStatus(chatId: string, userId: string): Promise<boolean> {
    const version = await this.getClaudeVersion();
    const workDir = this.deps.sessionManager.getWorkDir(userId);
    const convId = this.deps.sessionManager.getConvId(userId);
    const sessionId = this.deps.sessionManager.getSessionIdForConv(userId, convId);
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
    await this.deps.sender.sendTextReply(chatId, lines.join('\n'));
    return true;
  }

  /**
   * 处理 /model 命令
   */
  async handleModel(chatId: string, args: string): Promise<boolean> {
    const modelArg = args.trim();
    if (!modelArg) {
      await this.deps.sender.sendTextReply(
        chatId,
        `当前模型: ${this.deps.config.claudeModel ?? '默认 (由 Claude Code 决定)'}\n\n可选模型: sonnet, opus, haiku 或完整模型名\n用法: /model <模型名>`,
      );
    } else {
      this.deps.config.claudeModel = modelArg;
      await this.deps.sender.sendTextReply(chatId, `模型已切换为: ${modelArg}\n后续对话将使用此模型。`);
    }
    return true;
  }

  /**
   * 处理 /doctor 命令
   */
  async handleDoctor(chatId: string, userId: string): Promise<boolean> {
    const version = await this.getClaudeVersion();
    const lines = [
      '🏥 Claude Code 健康检查:',
      '',
      `CLI 路径: ${this.deps.config.claudeCliPath}`,
      `版本: ${version}`,
      `工作目录: ${this.deps.sessionManager.getWorkDir(userId)}`,
      `允许的基础目录: ${this.deps.config.allowedBaseDirs.join(', ')}`,
      `活跃任务数: ${this.deps.runningTasksSize}`,
    ];
    await this.deps.sender.sendTextReply(chatId, lines.join('\n'));
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
  ): Promise<boolean> {
    const convId = this.deps.sessionManager.getConvId(userId);
    const sessionId = this.deps.sessionManager.getSessionIdForConv(userId, convId);
    if (!sessionId) {
      await this.deps.sender.sendTextReply(chatId, '当前没有活动会话，无需压缩。');
      return true;
    }
    const instructions = args.trim();
    const compactPrompt = instructions
      ? `请压缩并总结之前的对话上下文，聚焦于: ${instructions}`
      : '请压缩并总结之前的对话上下文，保留关键信息。';

    const workDirSnapshot = this.deps.sessionManager.getWorkDir(userId);
    const enqueueResult = this.deps.requestQueue.enqueue(userId, convId, compactPrompt, async (prompt) => {
      await handleClaudeRequest(this.deps.config, this.deps.sessionManager, userId, chatId, prompt, workDirSnapshot, convId);
    });
    if (enqueueResult === 'rejected') {
      await this.deps.sender.sendTextReply(chatId, '请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await this.deps.sender.sendTextReply(chatId, '前面还有任务在处理中，压缩请求已排队等待。');
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
  ): Promise<boolean> {
    const workDirSnapshot = this.deps.sessionManager.getWorkDir(userId);
    const convIdSnapshot = this.deps.sessionManager.getConvId(userId);
    const todosPrompt = '请列出当前项目中所有的 TODO 项（检查代码中的 TODO、FIXME、HACK 注释）。';
    const enqueueResult = this.deps.requestQueue.enqueue(userId, convIdSnapshot, todosPrompt, async (prompt) => {
      await handleClaudeRequest(this.deps.config, this.deps.sessionManager, userId, chatId, prompt, workDirSnapshot, convIdSnapshot);
    });
    if (enqueueResult === 'rejected') {
      await this.deps.sender.sendTextReply(chatId, '请求队列已满，请等待当前任务完成后再试。');
    } else if (enqueueResult === 'queued') {
      await this.deps.sender.sendTextReply(chatId, '前面还有任务在处理中，请求已排队等待。');
    }
    return true;
  }

  /**
   * 处理 /allow 或 /y 命令
   */
  async handleAllow(chatId: string): Promise<boolean> {
    const reqId = resolveLatestPermission(chatId, 'allow');
    if (reqId) {
      const remaining = getPendingCount(chatId);
      await this.deps.sender.sendTextReply(chatId, `✅ 权限已允许${remaining > 0 ? `（还有 ${remaining} 个待确认）` : ''}`);
    } else {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求');
    }
    return true;
  }

  /**
   * 处理 /deny 或 /n 命令
   */
  async handleDeny(chatId: string): Promise<boolean> {
    const reqId = resolveLatestPermission(chatId, 'deny');
    if (reqId) {
      const remaining = getPendingCount(chatId);
      await this.deps.sender.sendTextReply(chatId, `❌ 权限已拒绝${remaining > 0 ? `（还有 ${remaining} 个待确认）` : ''}`);
    } else {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求');
    }
    return true;
  }

  /**
   * 处理 /allowall 命令
   */
  async handleAllowAll(chatId: string): Promise<boolean> {
    let count = 0;
    while (resolveLatestPermission(chatId, 'allow')) {
      count++;
    }
    if (count > 0) {
      await this.deps.sender.sendTextReply(chatId, `✅ 已批量允许 ${count} 个权限请求`);
    } else {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求');
    }
    return true;
  }

  /**
   * 处理 /pending 命令
   */
  async handlePending(chatId: string): Promise<boolean> {
    const pending = listPending(chatId);
    if (pending.length === 0) {
      await this.deps.sender.sendTextReply(chatId, 'ℹ️ 没有待确认的权限请求');
    } else {
      const list = pending.map((p: { toolName: string; id: string }, i: number) => `${i + 1}. ${p.toolName} (ID: ${p.id})`).join('\n');
      await this.deps.sender.sendTextReply(chatId, `🔐 待确认权限列表:\n\n${list}\n\n使用 /allow 允许最早的请求`);
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
