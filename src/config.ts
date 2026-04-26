try { await import('dotenv/config'); } catch {}
import { readFileSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { createLogger } from './logger.js';
import type { LogLevel } from './logger.js';
import { APP_HOME } from './constants.js';

const logger = createLogger('Config');

export type Platform = 'feishu' | 'telegram' | 'wecom';
export type AgentProvider = 'claude' | 'codex' | 'opencode';
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface Config {
  enabledPlatforms: Platform[]; // 改为支持多平台
  agentProvider: AgentProvider;
  agentCliPath: string;
  agentModel?: string;
  agentSkipPermissions: boolean;
  agentTimeoutMs: number;
  feishuAppId: string;
  feishuAppSecret: string;
  telegramBotToken: string;
  wecomBotId: string;
  wecomBotSecret: string;
  wecomBotName?: string;
  allowedUserIds: string[];
  claudeCliPath: string;
  claudeWorkDir: string;
  allowedBaseDirs: string[];
  codexCliPath: string;
  codexModel?: string;
  codexSandbox: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  opencodeCliPath: string;
  proxyUrl?: string;
  hookPort: number;
  logDir: string;
  logLevel: LogLevel;
}

interface FileConfig {
  agentProvider?: AgentProvider;
  agentModel?: string;
  agentSkipPermissions?: boolean;
  agentTimeoutMs?: number;
  feishuAppId?: string;
  feishuAppSecret?: string;
  telegramBotToken?: string;
  wecomBotId?: string;
  wecomBotSecret?: string;
  wecomBotName?: string;
  allowedUserIds?: string[];
  claudeCliPath?: string;
  claudeWorkDir?: string;
  allowedBaseDirs?: string[];
  claudeSkipPermissions?: boolean;
  claudeTimeoutMs?: number;
  claudeModel?: string;
  codexCliPath?: string;
  codexModel?: string;
  codexSandbox?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  opencodeCliPath?: string;
  proxyUrl?: string;
  hookPort?: number;
  logDir?: string;
  logLevel?: LogLevel;
}

function loadFileConfig(): FileConfig {
  const configPath = join(APP_HOME, 'config.json');
  try {
    const content = readFileSync(configPath, 'utf-8');
    logger.debug(`Loaded configuration from ${configPath}`);
    return JSON.parse(content);
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      logger.warn(`警告: 配置文件 ${configPath} 格式错误，将使用环境变量`);
      logger.warn(`错误详情: ${err.message}`);
    } else {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'ENOENT') {
        logger.warn(`警告: 无法读取配置文件 ${configPath}: ${error.message}`);
      }
    }
    return {};
  }
}

function parseCommaSeparated(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function isValidAgentProvider(value: string): value is AgentProvider {
  return value === 'claude' || value === 'codex' || value === 'opencode';
}

function isValidCodexSandbox(value: string): value is CodexSandboxMode {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

function isValidCodexApprovalPolicy(value: string): value is CodexApprovalPolicy {
  return value === 'untrusted' || value === 'on-request' || value === 'never';
}

function validateCliPath(cliPath: string, displayName: string): void {
  if (isAbsolute(cliPath) || cliPath.includes('/')) {
    try {
      accessSync(cliPath, constants.F_OK | constants.X_OK);
    } catch (_err) {
      throw new Error(
        `${displayName} 不可访问或不可执行: ${cliPath}\n` +
        `请检查：\n` +
        '  1. 文件是否存在\n' +
        '  2. 是否有执行权限\n' +
        `  3. ${displayName.toUpperCase().replace(/\s+/g, '_')}_PATH 环境变量或 ${APP_HOME} 配置是否正确`
      );
    }
    return;
  }

  try {
    execFileSync('which', [cliPath], { stdio: 'pipe' });
  } catch (_err) {
    throw new Error(
      `${displayName} 在 PATH 中未找到: ${cliPath}\n` +
      `请检查：\n` +
      `  1. 是否已安装 ${displayName}\n` +
      '  2. 命令是否在 PATH 环境变量中\n' +
      `  3. 或通过 ${displayName.toUpperCase().replace(/\s+/g, '_')}_PATH 指定完整路径`
    );
  }
}

function detectPlatforms(file: FileConfig): Platform[] {
  const platforms: Platform[] = [];

  // 检测 Telegram
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN ?? file.telegramBotToken;
  if (telegramToken) {
    platforms.push('telegram');
  }

  // 检测飞书
  const feishuAppId = process.env.FEISHU_APP_ID ?? file.feishuAppId;
  const feishuAppSecret = process.env.FEISHU_APP_SECRET ?? file.feishuAppSecret;
  if (feishuAppId && feishuAppSecret) {
    platforms.push('feishu');
  }

  // 检测企业微信
  const wecomBotId = process.env.WECOM_BOT_ID ?? file.wecomBotId;
  const wecomBotSecret = process.env.WECOM_BOT_SECRET ?? file.wecomBotSecret;
  if (wecomBotId && wecomBotSecret) {
    platforms.push('wecom');
  }

  // 如果都没配置，抛出错误
  if (platforms.length === 0) {
    const hints: string[] = [];
    if (feishuAppId && !feishuAppSecret) {
      hints.push('  飞书: 检测到 FEISHU_APP_ID 但缺少 FEISHU_APP_SECRET');
    } else if (!feishuAppId && feishuAppSecret) {
      hints.push('  飞书: 检测到 FEISHU_APP_SECRET 但缺少 FEISHU_APP_ID');
    }
    if (wecomBotId && !wecomBotSecret) {
      hints.push('  企业微信: 检测到 WECOM_BOT_ID 但缺少 WECOM_BOT_SECRET');
    } else if (!wecomBotId && wecomBotSecret) {
      hints.push('  企业微信: 检测到 WECOM_BOT_SECRET 但缺少 WECOM_BOT_ID');
    }

    const hintBlock = hints.length > 0
      ? '\n\n⚠️  检测到不完整的配置:\n' + hints.join('\n')
      : '';

    throw new Error(
      '至少需要配置一个平台：\n' +
      '  Telegram: 设置 TELEGRAM_BOT_TOKEN\n' +
      '  飞书: 设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET\n' +
      '  企业微信: 设置 WECOM_BOT_ID 和 WECOM_BOT_SECRET' +
      hintBlock
    );
  }

  return platforms;
}

export function loadConfig(): Config {
  const file = loadFileConfig();
  const enabledPlatforms = detectPlatforms(file);
  const rawAgentProvider = process.env.AGENT_PROVIDER ?? file.agentProvider ?? 'claude';
  if (!isValidAgentProvider(rawAgentProvider)) {
    throw new Error(`不支持的 AGENT_PROVIDER: ${rawAgentProvider}，可选值: claude / codex`);
  }
  if (rawAgentProvider === 'opencode') {
    throw new Error('AGENT_PROVIDER=opencode 暂未实现，目前可选: claude / codex');
  }
  const agentProvider = rawAgentProvider;

  // 飞书配置
  const appId = process.env.FEISHU_APP_ID ?? file.feishuAppId ?? '';
  const appSecret = process.env.FEISHU_APP_SECRET ?? file.feishuAppSecret ?? '';

  // Telegram 配置
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? file.telegramBotToken ?? '';

  // 企业微信配置
  const wecomBotId = process.env.WECOM_BOT_ID ?? file.wecomBotId ?? '';
  const wecomBotSecret = process.env.WECOM_BOT_SECRET ?? file.wecomBotSecret ?? '';
  const wecomBotName = process.env.WECOM_BOT_NAME ?? file.wecomBotName;

  const allowedUserIds =
    process.env.ALLOWED_USER_IDS !== undefined
      ? parseCommaSeparated(process.env.ALLOWED_USER_IDS)
      : file.allowedUserIds ?? [];

  const claudeCliPath = process.env.CLAUDE_CLI_PATH ?? file.claudeCliPath ?? 'claude';
  const codexCliPath = process.env.CODEX_CLI_PATH ?? file.codexCliPath ?? 'codex';
  const opencodeCliPath = process.env.OPENCODE_CLI_PATH ?? file.opencodeCliPath ?? 'opencode';
  const claudeWorkDir = process.env.CLAUDE_WORK_DIR ?? file.claudeWorkDir ?? process.cwd();

  const allowedBaseDirs =
    process.env.ALLOWED_BASE_DIRS !== undefined
      ? parseCommaSeparated(process.env.ALLOWED_BASE_DIRS)
      : file.allowedBaseDirs ?? [];
  if (allowedBaseDirs.length === 0) {
    allowedBaseDirs.push(claudeWorkDir);
  }

  const agentSkipPermissions =
    process.env.AGENT_SKIP_PERMISSIONS !== undefined
      ? process.env.AGENT_SKIP_PERMISSIONS === 'true'
      : process.env.CLAUDE_SKIP_PERMISSIONS !== undefined
        ? process.env.CLAUDE_SKIP_PERMISSIONS === 'true'
        : file.agentSkipPermissions ?? file.claudeSkipPermissions ?? false;

  const DEFAULT_TIMEOUT_MS = 600000;
  const MIN_TIMEOUT_MS = 10_000;
  const MAX_TIMEOUT_MS = 3_600_000;

  let agentTimeoutMs =
    process.env.AGENT_TIMEOUT_MS !== undefined
      ? parseInt(process.env.AGENT_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS
      : process.env.CLAUDE_TIMEOUT_MS !== undefined
        ? parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS
        : file.agentTimeoutMs ?? file.claudeTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (agentTimeoutMs < MIN_TIMEOUT_MS || agentTimeoutMs > MAX_TIMEOUT_MS) {
    logger.warn(`AGENT_TIMEOUT_MS=${agentTimeoutMs} 超出合理范围 (${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS})，使用默认值 ${DEFAULT_TIMEOUT_MS}`);
    agentTimeoutMs = DEFAULT_TIMEOUT_MS;
  }

  const claudeModel = process.env.CLAUDE_MODEL ?? file.claudeModel;
  const codexModel = process.env.CODEX_MODEL ?? file.codexModel;
  const agentModel = process.env.AGENT_MODEL ?? file.agentModel ?? (agentProvider === 'codex' ? codexModel : claudeModel);

  const rawCodexSandbox = process.env.CODEX_SANDBOX ?? file.codexSandbox ?? 'workspace-write';
  const codexSandbox = isValidCodexSandbox(rawCodexSandbox) ? rawCodexSandbox : 'workspace-write';
  if (!isValidCodexSandbox(rawCodexSandbox)) {
    logger.warn(`无效的 CODEX_SANDBOX="${rawCodexSandbox}"，使用默认值 workspace-write`);
  }

  const rawCodexApprovalPolicy = process.env.CODEX_APPROVAL_POLICY ?? file.codexApprovalPolicy ?? 'on-request';
  const codexApprovalPolicy = isValidCodexApprovalPolicy(rawCodexApprovalPolicy) ? rawCodexApprovalPolicy : 'on-request';
  if (!isValidCodexApprovalPolicy(rawCodexApprovalPolicy)) {
    logger.warn(`无效的 CODEX_APPROVAL_POLICY="${rawCodexApprovalPolicy}"，使用默认值 on-request`);
  }

  const activeCliPath = agentProvider === 'codex' ? codexCliPath : claudeCliPath;
  const activeCliName = agentProvider === 'codex' ? 'Codex CLI' : 'Claude CLI';
  validateCliPath(activeCliPath, activeCliName);

  const hookPort =
    process.env.HOOK_SERVER_PORT !== undefined
      ? parseInt(process.env.HOOK_SERVER_PORT, 10) || 18900
      : file.hookPort ?? 18900;

  const proxyUrl = process.env.PROXY_URL ?? file.proxyUrl;

  const logDir = process.env.LOG_DIR ?? file.logDir ?? join(APP_HOME, 'logs');
  const validLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
  const rawLogLevel = process.env.LOG_LEVEL?.toUpperCase() ?? file.logLevel ?? 'DEBUG';
  let logLevel: LogLevel;
  if (validLogLevels.includes(rawLogLevel)) {
    logLevel = rawLogLevel as LogLevel;
  } else {
    logger.warn(`无效的 LOG_LEVEL="${rawLogLevel}"，使用默认值 DEBUG`);
    logLevel = 'DEBUG';
  }

  return {
    enabledPlatforms,
    agentProvider,
    agentCliPath: activeCliPath,
    agentModel,
    agentSkipPermissions,
    agentTimeoutMs,
    feishuAppId: appId,
    feishuAppSecret: appSecret,
    telegramBotToken,
    wecomBotId,
    wecomBotSecret,
    wecomBotName,
    allowedUserIds,
    claudeCliPath,
    claudeWorkDir,
    allowedBaseDirs,
    codexCliPath,
    codexModel,
    codexSandbox,
    codexApprovalPolicy,
    opencodeCliPath,
    proxyUrl,
    hookPort,
    logDir,
    logLevel,
  };
}
