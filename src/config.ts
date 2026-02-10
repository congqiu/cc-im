import 'dotenv/config';
import { readFileSync } from 'node:fs';
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
  try {
    return JSON.parse(readFileSync(join(homedir(), '.cc-bot'), 'utf-8'));
  } catch {
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
