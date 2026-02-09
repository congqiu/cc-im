import type { StreamEvent, StreamContentBlockDelta, StreamResult } from './types.js';

export interface ParsedDelta {
  text: string;
}

export interface ParsedResult {
  success: boolean;
  result: string;
  cost: number;
  durationMs: number;
}

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

export function extractTextDelta(event: StreamEvent): ParsedDelta | null {
  if (
    event.type === 'stream_event' &&
    (event as StreamContentBlockDelta).event?.type === 'content_block_delta' &&
    (event as StreamContentBlockDelta).event?.delta?.text
  ) {
    return { text: (event as StreamContentBlockDelta).event.delta.text };
  }
  return null;
}

export function extractResult(event: StreamEvent): ParsedResult | null {
  if (event.type === 'result') {
    const r = event as StreamResult;
    return {
      success: r.subtype === 'success',
      result: r.result,
      cost: r.total_cost_usd,
      durationMs: r.duration_ms,
    };
  }
  return null;
}
