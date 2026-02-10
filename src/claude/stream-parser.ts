import { isContentBlockDelta, isStreamResult, type StreamEvent } from './types.js';

export interface ParsedDelta {
  text: string;
}

export interface ParsedResult {
  success: boolean;
  result: string;
  accumulated: string;
  cost: number;
  durationMs: number;
}

export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed as StreamEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractTextDelta(event: StreamEvent): ParsedDelta | null {
  if (isContentBlockDelta(event) && event.event.delta?.type === 'text_delta' && event.event.delta.text) {
    return { text: event.event.delta.text };
  }
  return null;
}

export function extractThinkingDelta(event: StreamEvent): ParsedDelta | null {
  if (isContentBlockDelta(event) && event.event.delta?.type === 'thinking_delta' && event.event.delta.thinking) {
    return { text: event.event.delta.thinking };
  }
  return null;
}

export function extractResult(event: StreamEvent): ParsedResult | null {
  if (isStreamResult(event)) {
    return {
      success: event.subtype === 'success',
      result: event.result,
      accumulated: '',
      cost: event.total_cost_usd,
      durationMs: event.duration_ms,
    };
  }
  return null;
}
