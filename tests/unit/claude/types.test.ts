import { describe, it, expect } from 'vitest';
import {
  isStreamInit,
  isContentBlockDelta,
  isStreamResult,
  type StreamInit,
  type StreamContentBlockDelta,
  type StreamResult,
  type StreamEvent,
} from '../../../src/claude/types.js';

describe('Claude Stream Types', () => {
  describe('isStreamInit', () => {
    it('应该正确识别 init 事件', () => {
      const event: StreamInit = {
        type: 'system',
        subtype: 'init',
        session_id: 'test-session-123',
        tools: [],
        mcp_servers: [],
        model: 'claude-opus-4',
      };
      expect(isStreamInit(event)).toBe(true);
    });

    it('应该拒绝非 init 事件', () => {
      const event: StreamEvent = {
        type: 'result',
        subtype: 'success',
        result: 'done',
        session_id: 'test',
        total_cost_usd: 0.01,
        duration_ms: 1000,
        duration_api_ms: 500,
        num_turns: 1,
      };
      expect(isStreamInit(event)).toBe(false);
    });

    it('应该拒绝缺少 subtype 的 system 事件', () => {
      const event = { type: 'system', session_id: 'test' };
      expect(isStreamInit(event as StreamEvent)).toBe(false);
    });
  });

  describe('isContentBlockDelta', () => {
    it('应该正确识别 content_block_delta 事件', () => {
      const event: StreamContentBlockDelta = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'Hello',
          },
        },
      };
      expect(isContentBlockDelta(event)).toBe(true);
    });

    it('应该拒绝不匹配的结构', () => {
      const event = {
        type: 'stream_event',
        event: {
          type: 'other_event',
          index: 0,
        },
      };
      expect(isContentBlockDelta(event as StreamEvent)).toBe(false);
    });

    it('应该拒绝缺少 event 字段的对象', () => {
      const event = { type: 'stream_event' };
      expect(isContentBlockDelta(event as StreamEvent)).toBe(false);
    });
  });

  describe('isStreamResult', () => {
    it('应该正确识别 success 结果', () => {
      const event: StreamResult = {
        type: 'result',
        subtype: 'success',
        result: 'Task completed',
        session_id: 'test-123',
        total_cost_usd: 0.05,
        duration_ms: 2000,
        duration_api_ms: 1500,
        num_turns: 2,
      };
      expect(isStreamResult(event)).toBe(true);
    });

    it('应该正确识别 error 结果', () => {
      const event: StreamResult = {
        type: 'result',
        subtype: 'error',
        result: 'Error occurred',
        session_id: 'test-123',
        total_cost_usd: 0.01,
        duration_ms: 500,
        duration_api_ms: 300,
        num_turns: 1,
      };
      expect(isStreamResult(event)).toBe(true);
    });

    it('应该拒绝缺少 subtype 的 result 事件', () => {
      const event = {
        type: 'result',
        result: 'done',
        session_id: 'test',
      };
      expect(isStreamResult(event as StreamEvent)).toBe(false);
    });
  });
});
