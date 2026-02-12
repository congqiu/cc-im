/**
 * 日志自动脱敏 — 在 logger 层统一调用，业务代码无需关心
 *
 * 规则：
 * 1. 飞书 open_id (ou_xxx)          → 保留前缀 + 前4位 + ****
 * 2. 绝对路径 /home/... /root/...   → 只保留最后两段
 * 3. UUID / session id              → 保留末4位
 * 4. 用户消息内容片段（不应出现在日志中，由调用方控制）
 */

const PATTERNS: [RegExp, (m: string) => string][] = [
  // 飞书 open_id: ou_ 开头，后跟 ≥6 个字母数字
  [/\bou_[a-zA-Z0-9]{6,}\b/g, (m) => m.slice(0, 7) + '****'],

  // UUID 格式的 session id
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    (m) => '****' + m.slice(-4)],

  // 绝对路径（/home/xxx/... 或 /root/xxx/...）—— 只保留最后两段
  [/\/(?:home|root|Users)\/\S{2,}/g, (m) => {
    const parts = m.split('/').filter(Boolean);
    return parts.length <= 2 ? m : '.../' + parts.slice(-2).join('/');
  }],
];

export function sanitize(text: string): string {
  let result = text;
  for (const [re, replacer] of PATTERNS) {
    result = result.replace(re, replacer);
  }
  return result;
}
