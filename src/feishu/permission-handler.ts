import { registerPermissionSender, resolvePermissionById } from '../hook/permission-server.js';
import { sendPermissionCard, updatePermissionCard } from './message-sender.js';
import { createLogger } from '../logger.js';

const log = createLogger('FeishuPermission');

/**
 * 注册飞书平台的权限消息发送器
 */
export function registerFeishuPermissionSender() {
  registerPermissionSender('feishu', {
    sendPermissionCard,
    updatePermissionCard: ({ messageId, toolName, decision }) =>
      updatePermissionCard(messageId, toolName, decision),
  });
}

/**
 * 处理权限按钮点击（allow/deny）
 */
export function handlePermissionAction(requestId: string, decision: 'allow' | 'deny') {
  const resolvedId = resolvePermissionById(requestId, decision);
  if (resolvedId) {
    log.info(`Permission ${decision} via button for request ${requestId}`);
  } else {
    log.warn(`No pending permission request found for requestId: ${requestId}`);
  }
}
