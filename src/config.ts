import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { createLogger } from './logger.js';
import { APP_HOME } from './constants.js';

const logger = createLogger('Config');

export type Platform = 'feishu' | 'telegram';

export interface Config {
  enabledPlatforms: Platform[]; // 改为支持多平台
  feishuAppId: string;
  feishuAppSecret: string;
  telegramBotToken: string;
  allowedUserIds: string[];
  claudeCliPath: string;
  claudeWorkDir: string;
  allowedBaseDirs: string[];
  claudeSkipPermissions: boolean;
  claudeTimeoutMs: number;
  claudeModel?: string;
  hookPort: number;
  logDir: string;
}

interface FileConfig {
  platform?: Platform;
  feishuAppId?: string;
  feishuAppSecret?: string;
  telegramBotToken?: string;
  allowedUserIds?: string[];
  claudeCliPath?: string;
  claudeWorkDir?: string;
  allowedBaseDirs?: string[];
  claudeSkipPermissions?: boolean;
  claudeTimeoutMs?: number;
  claudeModel?: string;
  logDir?: string;
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

  // 如果都没配置，抛出错误
  if (platforms.length === 0) {
    throw new Error(
      '至少需要配置一个平台：\n' +
      '  Telegram: 设置 TELEGRAM_BOT_TOKEN\n' +
      '  飞书: 设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET'
    );
  }

  return platforms;
}

export function loadConfig(): Config {
  const file = loadFileConfig();
  const enabledPlatforms = detectPlatforms(file);

  // 飞书配置
  const appId = process.env.FEISHU_APP_ID ?? file.feishuAppId ?? '';
  const appSecret = process.env.FEISHU_APP_SECRET ?? file.feishuAppSecret ?? '';

  // Telegram 配置
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? file.telegramBotToken ?? '';

  const allowedUserIds =
    process.env.ALLOWED_USER_IDS !== undefined
      ? parseCommaSeparated(process.env.ALLOWED_USER_IDS)
      : file.allowedUserIds ?? [];

  const claudeCliPath = process.env.CLAUDE_CLI_PATH ?? file.claudeCliPath ?? 'claude';
  const claudeWorkDir = process.env.CLAUDE_WORK_DIR ?? file.claudeWorkDir ?? process.cwd();

  const allowedBaseDirs =
    process.env.ALLOWED_BASE_DIRS !== undefined
      ? parseCommaSeparated(process.env.ALLOWED_BASE_DIRS)
      : file.allowedBaseDirs ?? [];
  if (allowedBaseDirs.length === 0) {
    allowedBaseDirs.push(claudeWorkDir);
  }

  const claudeSkipPermissions =
    process.env.CLAUDE_SKIP_PERMISSIONS !== undefined
      ? process.env.CLAUDE_SKIP_PERMISSIONS === 'true'
      : file.claudeSkipPermissions ?? false;

  const claudeTimeoutMs =
    process.env.CLAUDE_TIMEOUT_MS !== undefined
      ? parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 300000
      : file.claudeTimeoutMs ?? 300000;

  // 验证 Claude CLI 路径
  if (isAbsolute(claudeCliPath) || claudeCliPath.includes('/')) {
    // 绝对路径或包含目录分隔符：直接用 accessSync 验证
    try {
      accessSync(claudeCliPath, constants.F_OK | constants.X_OK);
    } catch (err) {
      throw new Error(
        `Claude CLI 不可访问或不可执行: ${claudeCliPath}\n` +
        `请检查：\n` +
        `  1. 文件是否存在\n` +
        `  2. 是否有执行权限\n` +
        `  3. CLAUDE_CLI_PATH 环境变量或 ${APP_HOME} 配置是否正确`
      );
    }
  } else {
    // 裸命令名（如 "claude"）：在 PATH 中查找
    try {
      execFileSync('which', [claudeCliPath], { stdio: 'pipe' });
    } catch (err) {
      throw new Error(
        `Claude CLI 在 PATH 中未找到: ${claudeCliPath}\n` +
        `请检查：\n` +
        `  1. 是否已安装 Claude CLI\n` +
        `  2. 命令是否在 PATH 环境变量中\n` +
        `  3. 或通过 CLAUDE_CLI_PATH 指定完整路径`
      );
    }
  }

  const hookPort =
    process.env.HOOK_SERVER_PORT !== undefined
      ? parseInt(process.env.HOOK_SERVER_PORT, 10) || 18900
      : 18900;

  const logDir = process.env.LOG_DIR ?? file.logDir ?? join(APP_HOME, 'logs');

  return {
    enabledPlatforms,
    feishuAppId: appId,
    feishuAppSecret: appSecret,
    telegramBotToken,
    allowedUserIds,
    claudeCliPath,
    claudeWorkDir,
    allowedBaseDirs,
    claudeSkipPermissions,
    claudeTimeoutMs,
    claudeModel: file.claudeModel,
    hookPort,
    logDir,
  };
}

/**
 * 将运行时可变配置（如 claudeModel）持久化到配置文件
 */
export function saveRuntimeConfig(config: Config): void {
  const configPath = join(APP_HOME, 'config.json');
  try {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // 文件不存在或格式错误，从空对象开始
    }
    if (config.claudeModel) {
      existing.claudeModel = config.claudeModel;
    } else {
      delete existing.claudeModel;
    }
    mkdirSync(APP_HOME, { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    logger.debug('Runtime config saved');
  } catch (err) {
    logger.warn('Failed to save runtime config:', err);
  }
}
