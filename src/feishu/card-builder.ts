import { MAX_STREAMING_CONTENT_LENGTH } from '../constants.js';
import { splitLongContent as sharedSplitLongContent } from '../shared/utils.js';
import { buildInputSummary } from '../shared/utils.js';

export type CardStatus = 'processing' | 'thinking' | 'streaming' | 'done' | 'error';

interface CardOptions {
  content: string;
  status: CardStatus;
  note?: string;
  thinking?: string;
}

const HEADER_TEMPLATES: Record<CardStatus, string> = {
  processing: 'blue',
  thinking: 'blue',
  streaming: 'blue',
  done: 'green',
  error: 'red',
};

const HEADER_TITLES: Record<CardStatus, string> = {
  processing: 'Claude Code - 处理中...',
  thinking: 'Claude Code - 思考中...',
  streaming: 'Claude Code',
  done: 'Claude Code',
  error: 'Claude Code - 错误',
};

const MAX_CARD_CONTENT_LENGTH = 3800;

export function truncateForCard(text: string): string {
  if (text.length <= MAX_CARD_CONTENT_LENGTH) return text;
  // 保留尾部内容，在换行符处截断以避免断行
  const keepLen = MAX_CARD_CONTENT_LENGTH - 20;
  const tail = text.slice(text.length - keepLen);
  const lineBreak = tail.indexOf('\n');
  const clean = lineBreak > 0 && lineBreak < 200 ? tail.slice(lineBreak + 1) : tail;
  return `...(前文已省略)...\n${clean}`;
}

export function buildCardObject(options: CardOptions, messageId?: string): Record<string, unknown> {
  const { content, status, note } = options;

  const elements: unknown[] = [
    {
      tag: 'markdown',
      content: truncateForCard(content) || '...',
    },
  ];

  if (note) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: note }],
    });
  }

  // 在处理中、思考中和流式输出状态时添加停止按钮
  if ((status === 'processing' || status === 'thinking' || status === 'streaming') && messageId) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: '⏹️ 停止',
          },
          type: 'danger',
          value: { action: 'stop', message_id: messageId },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: HEADER_TEMPLATES[status],
      title: {
        tag: 'plain_text',
        content: HEADER_TITLES[status],
      },
    },
    elements,
  };
}

export function buildCard(options: CardOptions, messageId?: string): string {
  return JSON.stringify(buildCardObject(options, messageId));
}

export function splitLongContent(text: string, maxLen = MAX_CARD_CONTENT_LENGTH): string[] {
  return sharedSplitLongContent(text, maxLen);
}

export function buildPermissionCard(requestId: string, toolName: string, toolInput: Record<string, unknown>): string {
  const inputSummary = buildInputSummary(toolName, toolInput);

  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `🔐 权限确认 - ${toolName}` },
    },
    elements: [
      { tag: 'markdown', content: truncateForCard(inputSummary) },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `ID: ${requestId} | 回复 /allow 允许 · /deny 拒绝` }] },
    ],
  };
  return JSON.stringify(card);
}

export function buildPermissionResultCard(toolName: string, decision: 'allow' | 'deny'): string {
  const isAllowed = decision === 'allow';
  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: isAllowed ? 'green' : 'red',
      title: { tag: 'plain_text', content: `🔐 ${toolName} - ${isAllowed ? '已允许 ✓' : '已拒绝 ✗'}` },
    },
    elements: [
      { tag: 'markdown', content: isAllowed ? '✅ 操作已允许执行。' : '❌ 操作已被拒绝。' },
    ],
  };
  return JSON.stringify(card);
}

// ─── CardKit JSON 2.0 ───

export function truncateForStreaming(text: string): string {
  if (text.length <= MAX_STREAMING_CONTENT_LENGTH) return text;
  const keepLen = MAX_STREAMING_CONTENT_LENGTH - 20;
  const tail = text.slice(text.length - keepLen);
  const lineBreak = tail.indexOf('\n');
  const clean = lineBreak > 0 && lineBreak < 200 ? tail.slice(lineBreak + 1) : tail;
  return `...(前文已省略)...\n${clean}`;
}

export function buildCardV2Object(options: CardOptions, cardId?: string): Record<string, unknown> {
  const { content, status, note, thinking } = options;

  const elements: unknown[] = [];

  // 完成状态下，如果有思考过程，添加折叠面板
  if (status === 'done' && thinking) {
    elements.push({
      tag: 'collapsible_panel',
      expanded: false,
      header: {
        title: { tag: 'markdown', content: '💭 **思考过程**' },
      },
      border: { color: 'grey' },
      elements: [{ tag: 'markdown', content: thinking }],
    });
  }

  elements.push({
    tag: 'markdown',
    content: truncateForStreaming(content) || '...',
    element_id: 'main_content',
  });

  elements.push({
    tag: 'markdown',
    content: note || '',
    text_size: 'notation',
    element_id: 'note_area',
  });

  // 在处理中、思考中和流式输出状态时添加停止按钮
  if ((status === 'processing' || status === 'thinking' || status === 'streaming') && cardId) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⏹️ 停止' },
      type: 'danger',
      value: { action: 'stop', card_id: cardId },
      element_id: 'action_stop',
    });
  }

  const isActive = status === 'processing' || status === 'thinking' || status === 'streaming';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      ...(isActive ? { streaming_mode: true } : {}),
    },
    header: {
      template: HEADER_TEMPLATES[status],
      title: { tag: 'plain_text', content: HEADER_TITLES[status] },
    },
    body: {
      direction: 'vertical',
      elements,
    },
  };
}

export function buildCardV2(options: CardOptions, cardId?: string): string {
  return JSON.stringify(buildCardV2Object(options, cardId));
}
