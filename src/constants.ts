import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/**
 * 系统级常量定义
 */

/**
 * 应用数据根目录 ~/.cc-im
 */
export const APP_HOME = join(homedir(), '.cc-im');

export const IMAGE_DIR = join(tmpdir(), 'cc-im-images');

/**
 * 只读工具列表 - 这些工具不需要权限确认
 * 用于 Hook Script 中判断是否需要请求用户授权
 */
export const READ_ONLY_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoRead',
];

/**
 * 仅终端可用的命令集合
 * 这些命令只能在 Claude Code CLI 终端交互模式下使用
 * 在飞书/Telegram 等消息平台中不可用
 */
export const TERMINAL_ONLY_COMMANDS = new Set([
  '/context',
  '/rewind',
  '/resume',
  '/copy',
  '/export',
  '/config',
  '/init',
  '/memory',
  '/permissions',
  '/theme',
  '/vim',
  '/statusline',
  '/terminal-setup',
  '/debug',
  '/tasks',
  '/mcp',
  '/teleport',
  '/add-dir',
]);

/**
 * 消息去重 TTL（毫秒）
 * 用于防止重复处理同一消息
 */
export const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * 消息更新节流时间（毫秒）
 * Telegram 使用 editMessageText，限频较严
 */
export const THROTTLE_MS = 200;

/**
 * CardKit 流式更新节流时间（毫秒）
 * cardElement.content 专为流式设计，支持更高频率
 */
export const CARDKIT_THROTTLE_MS = 80;

/**
 * 飞书卡片最大内容长度（JSON 1.0 / im.v1.message.patch）
 */
export const MAX_CARD_CONTENT_LENGTH = 3800;

/**
 * CardKit 流式内容最大长度（CardKit 卡片上限 30KB，留余量）
 */
export const MAX_STREAMING_CONTENT_LENGTH = 25000;

/**
 * Telegram 消息最大长度
 */
export const MAX_TELEGRAM_MESSAGE_LENGTH = 4000; // Telegram 限制 4096，留一些余地

/**
 * 权限请求超时时间（毫秒）
 */
export const PERMISSION_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * 权限请求体最大大小（字节）
 */
export const MAX_BODY_SIZE = 1024 * 1024; // 1MB

/**
 * Hook Script 退出码
 */
export const HOOK_EXIT_CODES = {
  /** 成功（允许或自动放行） */
  SUCCESS: 0,
  /** 一般错误 */
  ERROR: 1,
  /** 权限服务器不可达 */
  PERMISSION_SERVER_ERROR: 2,
} as const;

/**
 * 企业微信流式更新节流时间（毫秒）
 */
export const WECOM_THROTTLE_MS = 200;

/**
 * 企业微信流式消息续接阈值（毫秒）
 * 企业微信流式消息有 6 分钟硬超时，设 5 分 30 秒触发续接
 */
export const WECOM_STREAM_TIMEOUT_MS = 330_000;

/**
 * 企业微信消息最大长度
 * replyStream 的 content 最长不超过 20480 字节（utf-8）
 * 为安全起见，以字符计限制在 4000
 */
export const MAX_WECOM_MESSAGE_LENGTH = 4000;
