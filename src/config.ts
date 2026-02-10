import 'dotenv/config';
import { readFileSync, accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Config {
  feishuAppId: string;
  feishuAppSecret: string;
  allowedUserIds: string[];
  claudeCliPath: string;
  claudeWorkDir: string;
  allowedBaseDirs: string[];
  claudeSkipPermissions: boolean;
  claudeTimeoutMs: number;
  claudeModel?: string;
}

interface FileConfig {
  feishuAppId?: string;
  feishuAppSecret?: string;
  allowedUserIds?: string[];
  claudeCliPath?: string;
  claudeWorkDir?: string;
  allowedBaseDirs?: string[];
  claudeSkipPermissions?: boolean;
  claudeTimeoutMs?: number;
}

function loadFileConfig(): FileConfig {
  const configPath = join(homedir(), '.cc-bot');
  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    // ENOENT 是正常的（文件不存在），其他错误需要提示
    if (error.code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        console.warn(`警告: 配置文件 ${configPath} 格式错误，将使用环境变量`);
        console.warn(`错误详情: ${error.message}`);
      } else {
        console.warn(`警告: 无法读取配置文件 ${configPath}: ${error.message}`);
      }
    }
    return {};
  }
}

function parseCommaSeparated(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  const file = loadFileConfig();

  const appId = process.env.FEISHU_APP_ID ?? file.feishuAppId;
  const appSecret = process.env.FEISHU_APP_SECRET ?? file.feishuAppSecret;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set (via env or ~/.cc-bot)');
  }

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
  try {
    accessSync(claudeCliPath, constants.F_OK | constants.X_OK);
  } catch (err) {
    throw new Error(
      `Claude CLI 不可访问或不可执行: ${claudeCliPath}\n` +
      `请检查：\n` +
      `  1. 文件是否存在\n` +
      `  2. 是否有执行权限\n` +
      `  3. CLAUDE_CLI_PATH 环境变量或 ~/.cc-bot 配置是否正确`
    );
  }

  return {
    feishuAppId: appId,
    feishuAppSecret: appSecret,
    allowedUserIds,
    claudeCliPath,
    claudeWorkDir,
    allowedBaseDirs,
    claudeSkipPermissions,
    claudeTimeoutMs,
  };
}
