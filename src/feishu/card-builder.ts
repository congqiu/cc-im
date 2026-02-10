export type CardStatus = 'thinking' | 'streaming' | 'done' | 'error';

interface CardOptions {
  content: string;
  status: CardStatus;
  note?: string;
}

const HEADER_TEMPLATES: Record<CardStatus, string> = {
  thinking: 'blue',
  streaming: 'blue',
  done: 'green',
  error: 'red',
};

const HEADER_TITLES: Record<CardStatus, string> = {
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

export function buildCard(options: CardOptions, messageId?: string): string {
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

  // 在思考和流式输出状态时添加停止按钮
  if ((status === 'thinking' || status === 'streaming') && messageId) {
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
          value: JSON.stringify({ action: 'stop', message_id: messageId }),
        },
      ],
    });
  }

  const card = {
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

  return JSON.stringify(card);
}

export function splitLongContent(text: string, maxLen = MAX_CARD_CONTENT_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (start + maxLen >= text.length) {
      parts.push(text.slice(start));
      break;
    }
    // Try to find a newline near the split point to avoid breaking mid-line
    let end = start + maxLen;
    const searchStart = Math.max(start, end - 200);
    const lastNewline = text.lastIndexOf('\n', end);
    if (lastNewline > searchStart) {
      end = lastNewline + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}
