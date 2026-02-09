import 'dotenv/config';

export interface Config {
  feishuAppId: string;
  feishuAppSecret: string;
  allowedUserIds: string[];
  claudeCliPath: string;
  claudeWorkDir: string;
}

export function loadConfig(): Config {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set');
  }

  const allowedRaw = process.env.ALLOWED_USER_IDS ?? '';
  const allowedUserIds = allowedRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const claudeCliPath = process.env.CLAUDE_CLI_PATH ?? 'claude';
  const claudeWorkDir = process.env.CLAUDE_WORK_DIR ?? process.cwd();

  return { feishuAppId: appId, feishuAppSecret: appSecret, allowedUserIds, claudeCliPath, claudeWorkDir };
}
