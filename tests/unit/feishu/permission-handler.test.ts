import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/hook/permission-server.js', () => ({
  registerPermissionSender: vi.fn(),
  resolvePermissionById: vi.fn(),
}));

vi.mock('../../../src/feishu/message-sender.js', () => ({
  sendPermissionCard: vi.fn(),
  updatePermissionCard: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerPermissionSender, resolvePermissionById } from '../../../src/hook/permission-server.js';
import { sendPermissionCard, updatePermissionCard } from '../../../src/feishu/message-sender.js';
import { registerFeishuPermissionSender, handlePermissionAction } from '../../../src/feishu/permission-handler.js';

describe('permission-handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('registerFeishuPermissionSender', () => {
    it('应注册飞书权限发送器', () => {
      registerFeishuPermissionSender();
      expect(registerPermissionSender).toHaveBeenCalledWith('feishu', expect.objectContaining({
        sendPermissionCard: expect.any(Function),
        updatePermissionCard: expect.any(Function),
      }));
    });

    it('应只注册一次', () => {
      registerFeishuPermissionSender();
      expect(registerPermissionSender).toHaveBeenCalledTimes(1);
    });

    it('注册的 sendPermissionCard 应指向 message-sender 中的实现', () => {
      registerFeishuPermissionSender();
      const registeredSender = vi.mocked(registerPermissionSender).mock.calls[0][1];
      expect(registeredSender.sendPermissionCard).toBe(sendPermissionCard);
    });

    it('注册的 updatePermissionCard 应为包装函数', async () => {
      vi.mocked(updatePermissionCard).mockResolvedValue(undefined as any);
      registerFeishuPermissionSender();

      const registeredSender = vi.mocked(registerPermissionSender).mock.calls[0][1];
      await registeredSender.updatePermissionCard({
        messageId: 'msg-001',
        toolName: 'Bash',
        decision: 'allow',
      });

      expect(updatePermissionCard).toHaveBeenCalledWith('msg-001', 'Bash', 'allow');
    });
  });

  describe('handlePermissionAction', () => {
    it('应解析权限请求 (allow)', () => {
      vi.mocked(resolvePermissionById).mockReturnValue('req-123');
      handlePermissionAction('req-123', 'allow');
      expect(resolvePermissionById).toHaveBeenCalledWith('req-123', 'allow');
    });

    it('应解析权限请求 (deny)', () => {
      vi.mocked(resolvePermissionById).mockReturnValue('req-456');
      handlePermissionAction('req-456', 'deny');
      expect(resolvePermissionById).toHaveBeenCalledWith('req-456', 'deny');
    });

    it('请求不存在时应记录警告但不抛出异常', () => {
      vi.mocked(resolvePermissionById).mockReturnValue(undefined);
      expect(() => {
        handlePermissionAction('req-nonexistent', 'allow');
      }).not.toThrow();
      expect(resolvePermissionById).toHaveBeenCalledWith('req-nonexistent', 'allow');
    });

    it('resolvePermissionById 返回有效 ID 时应正常处理', () => {
      vi.mocked(resolvePermissionById).mockReturnValue('req-789');
      handlePermissionAction('req-789', 'deny');
      expect(resolvePermissionById).toHaveBeenCalledTimes(1);
    });
  });
});
