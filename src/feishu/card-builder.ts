export type CardStatus = 'processing' | 'thinking' | 'streaming' | 'done' | 'error';

interface CardOptions {
  content: string;
  status: CardStatus;
  note?: string;
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

export function buildPermissionCard(requestId: string, toolName: string, toolInput: Record<string, unknown>): string {
  let inputSummary: string;
  if (toolName === 'Bash' && toolInput.command) {
    inputSummary = String(toolInput.command);
  } else if (toolName === 'Write' && toolInput.file_path) {
    inputSummary = `文件: ${toolInput.file_path}\n内容长度: ${String(toolInput.content ?? '').length} 字符`;
  } else if (toolName === 'Edit' && toolInput.file_path) {
    inputSummary = `文件: ${toolInput.file_path}`;
  } else {
    const keys = Object.keys(toolInput);
    if (keys.length === 0) {
      inputSummary = '(无参数)';
    } else {
      const lines = keys.slice(0, 5).map((k) => {
        const v = String(toolInput[k] ?? '');
        return `${k}: ${v.length > 200 ? v.slice(0, 200) + '...' : v}`;
      });
      inputSummary = lines.join('\n');
    }
  }

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
