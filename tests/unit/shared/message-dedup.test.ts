import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageDedup } from '../../../src/shared/message-dedup.js';

describe('MessageDedup', () => {
  let dedup: MessageDedup;

  beforeEach(() => {
    dedup = new MessageDedup();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('新消息返回 false', () => {
    expect(dedup.isDuplicate('msg-1')).toBe(false);
  });

  it('重复消息返回 true', () => {
    dedup.isDuplicate('msg-1');
    expect(dedup.isDuplicate('msg-1')).toBe(true);
  });

  it('不同消息互不影响', () => {
    expect(dedup.isDuplicate('msg-1')).toBe(false);
    expect(dedup.isDuplicate('msg-2')).toBe(false);
    expect(dedup.isDuplicate('msg-1')).toBe(true);
    expect(dedup.isDuplicate('msg-2')).toBe(true);
  });

  it('过期消息不再被视为重复', () => {
    dedup.isDuplicate('msg-1');

    // 超过 DEDUP_TTL_MS（5 分钟）
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // 插入新消息触发过期清理
    expect(dedup.isDuplicate('msg-2')).toBe(false);
    // msg-1 已过期，不再重复
    expect(dedup.isDuplicate('msg-1')).toBe(false);
  });

  it('未过期消息仍然被视为重复', () => {
    dedup.isDuplicate('msg-1');

    vi.advanceTimersByTime(4 * 60 * 1000); // 4 分钟，未过期

    dedup.isDuplicate('msg-2'); // 触发清理
    expect(dedup.isDuplicate('msg-1')).toBe(true);
  });

  it('超过最大容量时淘汰最早的条目', () => {
    // 插入 1001 条消息
    for (let i = 0; i < 1001; i++) {
      dedup.isDuplicate(`msg-${i}`);
    }

    // msg-0 应该被淘汰
    expect(dedup.isDuplicate('msg-0')).toBe(false);
    // msg-1 也被淘汰（因为 msg-0 重新插入后容量又超了）
    expect(dedup.isDuplicate('msg-1')).toBe(false);
    // 较新的消息仍在
    expect(dedup.isDuplicate('msg-1000')).toBe(true);
  });
});
