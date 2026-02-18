export interface StreamInit {
  type: 'system';
  subtype: 'init';
  session_id: string;
  tools: unknown[];
  mcp_servers: unknown[];
  model: string;
}

export interface StreamContentBlockDelta {
  type: 'stream_event';
  event: {
    type: 'content_block_delta';
    index: number;
    delta: {
      type: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  };
}

export interface StreamContentBlockStop {
  type: 'stream_event';
  event: { type: 'content_block_stop'; index: number; };
}

export interface StreamAssistantMessage {
  type: 'assistant';
  message: {
    id: string;
    role: 'assistant';
    content: Array<{ type: 'text'; text: string }>;
    model: string;
  };
  session_id: string;
}

export interface StreamResult {
  type: 'result';
  subtype: 'success' | 'error';
  result: string;
  session_id: string;
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
}

export interface StreamContentBlockStart {
  type: 'stream_event';
  event: {
    type: 'content_block_start';
    index: number;
    content_block: {
      type: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    };
  };
}

export type StreamEvent = StreamInit | StreamContentBlockDelta | StreamContentBlockStart | StreamContentBlockStop | StreamAssistantMessage | StreamResult | { type: string; [key: string]: unknown };

export function isStreamInit(event: StreamEvent): event is StreamInit {
  return event.type === 'system' && 'subtype' in event && event.subtype === 'init';
}

export function isContentBlockDelta(event: StreamEvent): event is StreamContentBlockDelta {
  return (
    event.type === 'stream_event' &&
    'event' in event &&
    typeof event.event === 'object' &&
    event.event !== null &&
    'type' in event.event &&
    event.event.type === 'content_block_delta'
  );
}

export function isStreamResult(event: StreamEvent): event is StreamResult {
  return event.type === 'result' && 'subtype' in event;
}

export function isContentBlockStart(event: StreamEvent): event is StreamContentBlockStart {
  return (
    event.type === 'stream_event' &&
    'event' in event &&
    typeof event.event === 'object' &&
    event.event !== null &&
    'type' in event.event &&
    event.event.type === 'content_block_start'
  );
}

export function isContentBlockStop(event: StreamEvent): event is StreamContentBlockStop {
  return (
    event.type === 'stream_event' &&
    'event' in event &&
    typeof event.event === 'object' &&
    event.event !== null &&
    'type' in event.event &&
    event.event.type === 'content_block_stop'
  );
}
