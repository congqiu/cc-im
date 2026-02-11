import { describe, it, expect } from 'vitest';
import { AccessControl } from '../../../src/access/access-control.js';

describe('AccessControl', () => {
  describe('空白名单（开发模式）', () => {
    it('应该允许所有用户', () => {
      const ac = new AccessControl([]);
      expect(ac.isAllowed('user1')).toBe(true);
      expect(ac.isAllowed('user2')).toBe(true);
      expect(ac.isAllowed('any-user')).toBe(true);
    });
  });

  describe('白名单模式', () => {
    it('应该允许白名单中的用户', () => {
      const ac = new AccessControl(['user1', 'user2']);
      expect(ac.isAllowed('user1')).toBe(true);
      expect(ac.isAllowed('user2')).toBe(true);
    });

    it('应该拒绝不在白名单中的用户', () => {
      const ac = new AccessControl(['user1', 'user2']);
      expect(ac.isAllowed('user3')).toBe(false);
      expect(ac.isAllowed('unknown')).toBe(false);
    });
  });
});
