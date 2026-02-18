import { describe, it, expect } from 'vitest';
import {
  parseStreamLine,
  extractTextDelta,
  extractThinkingDelta,
  extractResult,
} from '../../../src/claude/stream-parser.js';
import type { StreamEvent } from '../../../src/claude/types.js';

describe('Stream Parser', () => {
  describe('parseStreamLine', () => {
    it('应该解析合法的 JSON 行', () => {
      const line = '{"type": "system", "subtype": "init", "session_id": "test"}';
      const event = parseStreamLine(line);
      expect(event).not.toBeNull();
      expect(event?.type).toBe('system');
    });

    it('应该忽略空行', () => {
      expect(parseStreamLine('')).toBeNull();
      expect(parseStreamLine('   ')).toBeNull();
      expect(parseStreamLine('\n')).toBeNull();
    });

    it('应该忽略非 JSON 行', () => {
      expect(parseStreamLine('not a json')).toBeNull();
      expect(parseStreamLine('{ invalid json')).toBeNull();
    });

    it('应该忽略无 type 字段的 JSON', () => {
      const line = '{"foo": "bar"}';
      const event = parseStreamLine(line);
      expect(event).toBeNull();
    });

    it('type 不是字符串的 JSON 仍可被解析', () => {
      const line = '{"type": 123}';
      const event = parseStreamLine(line);
      expect(event).not.toBeNull();
    });
  });

  describe('extractTextDelta', () => {
    it('应该提取 text_delta', () => {
      const event: StreamEvent = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: 'Hello, world!',
          },
        },
      };
      const delta = extractTextDelta(event);
      expect(delta).toEqual({ text: 'Hello, world!' });
    });

    it('应该忽略 thinking_delta', () => {
      const event: StreamEvent = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: 'Thinking...',
          },
        },
      };
      const delta = extractTextDelta(event);
      expect(delta).toBeNull();
    });

    it('应该忽略空文本的 text_delta', () => {
      const event: StreamEvent = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'text_delta',
            text: '',
          },
        },
      };
      const delta = extractTextDelta(event);
      expect(delta).toBeNull();
    });

    it('应该对非 content_block_delta 事件返回 null', () => {
      const event: StreamEvent = {
        type: 'result',
        subtype: 'success',
        result: 'done',
        session_id: 'test',
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
      };
      const delta = extractTextDelta(event);
      expect(delta).toBeNull();
    });
  });

  describe('extractThinkingDelta', () => {
    it('应该提取 thinking_delta', () => {
      const event: StreamEvent = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: 'Let me think...',
          },
        },
      };
      const delta = extractThinkingDelta(event);
      expect(delta).toEqual({ text: 'Let me think...' });
    });

    it('应该忽略 text_delta', () => {
      const event: StreamEvent = {
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
      const delta = extractThinkingDelta(event);
      expect(delta).toBeNull();
    });

    it('应该忽略空的 thinking_delta', () => {
      const event: StreamEvent = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'thinking_delta',
            thinking: '',
          },
        },
      };
      const delta = extractThinkingDelta(event);
      expect(delta).toBeNull();
    });
  });

  describe('extractResult', () => {
    it('应该提取成功结果', () => {
      const event: StreamEvent = {
        type: 'result',
        subtype: 'success',
        result: 'Task completed successfully',
        session_id: 'test-123',
        total_cost_usd: 0.05,
        duration_ms: 2500,
        duration_api_ms: 2000,
        num_turns: 3,
      };
      const result = extractResult(event);
      expect(result).toEqual({
        success: true,
        result: 'Task completed successfully',
        accumulated: '',
        cost: 0.05,
        durationMs: 2500,
        numTurns: 3,
        toolStats: {},
      });
    });

    it('应该提取失败结果', () => {
      const event: StreamEvent = {
        type: 'result',
        subtype: 'error',
        result: 'Something went wrong',
        session_id: 'test-456',
        total_cost_usd: 0.01,
        duration_ms: 500,
        duration_api_ms: 300,
        num_turns: 1,
      };
      const result = extractResult(event);
      expect(result).toEqual({
        success: false,
        result: 'Something went wrong',
        accumulated: '',
        cost: 0.01,
        durationMs: 500,
        numTurns: 1,
        toolStats: {},
      });
    });

    it('应该对非 result 事件返回 null', () => {
      const event: StreamEvent = {
        type: 'system',
        subtype: 'init',
        session_id: 'test',
        tools: [],
        mcp_servers: [],
        model: 'claude',
      };
      const result = extractResult(event);
      expect(result).toBeNull();
    });
  });
});
