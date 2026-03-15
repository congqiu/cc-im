import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HistoryPage, SessionListItem } from '../../../src/shared/history.js';

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

// Mock node:os
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}));

import { readFile, readdir, stat } from 'node:fs/promises';
import { getHistory, formatHistoryPage, getSessionList, formatSessionList } from '../../../src/shared/history.js';

const mockReadFile = vi.mocked(readFile);
const mockReaddir = vi.mocked(readdir);
const mockStat = vi.mocked(stat);

function userLine(content: string, timestamp = '2024-01-01T00:00:00Z') {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp });
}

function assistantLine(text: string, timestamp = '2024-01-01T00:01:00Z') {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('getHistory', () => {
  const workDir = '/home/user/project';
  // encodeWorkDir replaces / with -
  const projectDir = '/mock-home/.claude/projects/-home-user-project';

  describe('指定 sessionId', () => {
    it('读取文件并解析条目', async () => {
      const jsonl = [userLine('hello'), assistantLine('hi there')].join('\n');
      mockReadFile.mockResolvedValue(jsonl);

      const result = await getHistory(workDir, 'abc-123', 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.sessionId).toBe('abc-123');
      expect(result.data.entries).toHaveLength(2);
      expect(result.data.entries[0]).toEqual({
        role: 'user',
        text: 'hello',
        timestamp: '2024-01-01T00:00:00Z',
      });
      expect(result.data.entries[1]).toEqual({
        role: 'assistant',
        text: 'hi there',
        timestamp: '2024-01-01T00:01:00Z',
      });
      expect(mockReadFile).toHaveBeenCalledWith(`${projectDir}/abc-123.jsonl`, 'utf-8');
    });

    it('会话文件不存在时返回错误', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await getHistory(workDir, 'no-exist', 1);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('no-exist');
    });
  });

  describe('未指定 sessionId（自动查找最新）', () => {
    it('按 mtime 选择最新文件', async () => {
      mockReaddir.mockResolvedValue(['old.jsonl', 'new.jsonl'] as any);
      mockStat.mockImplementation(((p: string) => {
        if (String(p).includes('old.jsonl')) return Promise.resolve({ mtimeMs: 1000 });
        if (String(p).includes('new.jsonl')) return Promise.resolve({ mtimeMs: 2000 });
        return Promise.resolve({ mtimeMs: 0 });
      }) as any);
      mockReadFile.mockResolvedValue(userLine('latest'));

      const result = await getHistory(workDir, undefined, 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.sessionId).toBe('new');
      expect(mockReadFile).toHaveBeenCalledWith(`${projectDir}/new.jsonl`, 'utf-8');
    });

    it('过滤非 .jsonl 文件', async () => {
      mockReaddir.mockResolvedValue(['session.jsonl', 'readme.txt', 'data.json'] as any);
      mockStat.mockResolvedValue({ mtimeMs: 100 } as any);
      mockReadFile.mockResolvedValue(userLine('content'));

      const result = await getHistory(workDir, undefined, 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.sessionId).toBe('session');
    });
  });

  describe('目录不存在', () => {
    it('readdir 失败返回错误', async () => {
      mockReaddir.mockRejectedValue(new Error('ENOENT'));

      const result = await getHistory(workDir, undefined, 1);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('未找到会话记录目录。');
    });
  });

  describe('空会话', () => {
    it('目录中没有 jsonl 文件', async () => {
      mockReaddir.mockResolvedValue([] as any);

      const result = await getHistory(workDir, undefined, 1);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('未找到会话记录。');
    });

    it('文件存在但没有有效条目', async () => {
      const jsonl = [
        JSON.stringify({ type: 'system', message: { role: 'system', content: 'init' } }),
        '{"type":"user"}', // no message.content
      ].join('\n');
      mockReadFile.mockResolvedValue(jsonl);

      const result = await getHistory(workDir, 'empty-session', 1);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('会话中没有可显示的消息。');
    });
  });

  describe('分页', () => {
    function manyEntries(count: number): string {
      return Array.from({ length: count }, (_, i) => userLine(`msg-${i}`)).join('\n');
    }

    it('正确计算 page 和 totalPages', async () => {
      mockReadFile.mockResolvedValue(manyEntries(25));

      const result = await getHistory(workDir, 'sess', 2);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.page).toBe(2);
      expect(result.data.totalPages).toBe(3);
      expect(result.data.entries).toHaveLength(10);
      expect(result.data.entries[0].text).toBe('msg-10');
    });

    it('最后一页条目数不足 PAGE_SIZE', async () => {
      mockReadFile.mockResolvedValue(manyEntries(25));

      const result = await getHistory(workDir, 'sess', 3);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.page).toBe(3);
      expect(result.data.entries).toHaveLength(5);
      expect(result.data.entries[0].text).toBe('msg-20');
    });

    it('page 超出范围时 clamp 到最大页', async () => {
      mockReadFile.mockResolvedValue(manyEntries(5));

      const result = await getHistory(workDir, 'sess', 999);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.page).toBe(1);
      expect(result.data.totalPages).toBe(1);
    });

    it('page < 0 时返回最后一页', async () => {
      mockReadFile.mockResolvedValue(manyEntries(25));

      const result = await getHistory(workDir, 'sess', -1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.page).toBe(3);
      expect(result.data.totalPages).toBe(3);
    });

    it('page=0 时返回最后一页', async () => {
      mockReadFile.mockResolvedValue(manyEntries(25));
      const result = await getHistory(workDir, 'sess', 0);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.page).toBe(3);
      expect(result.data.totalPages).toBe(3);
      expect(result.data.entries).toHaveLength(5);
      expect(result.data.entries[0].text).toBe('msg-20');
    });
  });

  describe('条目过滤', () => {
    it('过滤非 user/assistant 类型', async () => {
      const lines = [
        JSON.stringify({ type: 'system', message: { role: 'system', content: 'setup' } }),
        userLine('real message'),
        JSON.stringify({ type: 'result', message: { role: 'tool', content: 'output' } }),
      ].join('\n');
      mockReadFile.mockResolvedValue(lines);

      const result = await getHistory(workDir, 'sess', 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0].text).toBe('real message');
    });

    it('过滤 <local-command 开头的条目', async () => {
      const lines = [
        userLine('<local-command name="compact"/>'),
        userLine('normal question'),
      ].join('\n');
      mockReadFile.mockResolvedValue(lines);

      const result = await getHistory(workDir, 'sess', 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0].text).toBe('normal question');
    });

    it('过滤 <command-name> 开头的条目', async () => {
      const lines = [
        userLine('<command-name>compact</command-name>'),
        userLine('hello'),
      ].join('\n');
      mockReadFile.mockResolvedValue(lines);

      const result = await getHistory(workDir, 'sess', 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0].text).toBe('hello');
    });

    it('过滤空文本条目', async () => {
      const lines = [
        userLine(''),
        userLine('  '),
        userLine('valid'),
      ].join('\n');
      mockReadFile.mockResolvedValue(lines);

      const result = await getHistory(workDir, 'sess', 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries).toHaveLength(1);
    });

    it('跳过格式错误的 JSON 行', async () => {
      const lines = ['not valid json', userLine('good')].join('\n');
      mockReadFile.mockResolvedValue(lines);

      const result = await getHistory(workDir, 'sess', 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0].text).toBe('good');
    });

    it('assistant 消息从 content 数组提取文本', async () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first part' },
            { type: 'tool_use', id: '1', name: 'Read', input: {} },
            { type: 'text', text: 'second part' },
          ],
        },
        timestamp: '2024-01-01',
      });
      mockReadFile.mockResolvedValue(line);

      const result = await getHistory(workDir, 'sess', 1);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.entries[0].text).toBe('first part\nsecond part');
    });
  });
});

describe('formatHistoryPage', () => {
  it('正确格式化带 user/assistant 前缀和时间戳', () => {
    const page: HistoryPage = {
      entries: [
        { role: 'user', text: 'what is 1+1?', timestamp: '2024-06-15T10:30:00Z' },
        { role: 'assistant', text: 'the answer is 2', timestamp: '2024-06-15T10:31:00Z' },
      ],
      page: 1,
      totalPages: 1,
      sessionId: 'abcdef12345678',
    };

    const output = formatHistoryPage(page);

    expect(output).toContain('12345678'); // last 8 chars of sessionId
    expect(output).toContain('1/1');
    expect(output).toContain('what is 1+1?');
    expect(output).toContain('the answer is 2');
  });

  it('消息完整展示不截断', () => {
    const longText = 'x'.repeat(400);
    const page: HistoryPage = {
      entries: [{ role: 'user', text: longText, timestamp: '2024-06-15T10:30:00Z' }],
      page: 1,
      totalPages: 1,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    expect(output).toContain(longText);
    expect(output).not.toContain('...');
  });

  it('当天时间戳只显示 [HH:mm]', () => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const todayTs = now.toISOString();
    const page: HistoryPage = {
      entries: [{ role: 'user', text: 'hello', timestamp: todayTs }],
      page: 1,
      totalPages: 1,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    const expectedTime = `[${pad(now.getHours())}:${pad(now.getMinutes())}]`;
    expect(output).toContain(expectedTime);
    // 不应包含月-日格式
    expect(output).not.toMatch(/\[\d{2}-\d{2} /);
  });

  it('非当天时间戳显示 [MM-DD HH:mm]', () => {
    const page: HistoryPage = {
      entries: [{ role: 'user', text: 'hello', timestamp: '2024-06-15T10:30:00Z' }],
      page: 1,
      totalPages: 1,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    // 根据时区不同，具体值可能有变化，但应包含 MM-DD HH:mm 格式
    expect(output).toMatch(/\[\d{2}-\d{2} \d{2}:\d{2}\]/);
  });

  it('无时间戳时不报错', () => {
    const page: HistoryPage = {
      entries: [{ role: 'user', text: 'hello' }],
      page: 1,
      totalPages: 1,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    expect(output).toContain('hello');
  });

  it('第一页时只显示下一页提示', () => {
    const page: HistoryPage = {
      entries: [{ role: 'user', text: 'msg', timestamp: '2024-06-15T10:30:00Z' }],
      page: 1,
      totalPages: 3,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    expect(output).toContain('/history 2');
    expect(output).toContain('下一页');
    expect(output).not.toContain('上一页');
  });

  it('中间页同时显示上一页和下一页提示', () => {
    const page: HistoryPage = {
      entries: [{ role: 'user', text: 'msg', timestamp: '2024-06-15T10:30:00Z' }],
      page: 2,
      totalPages: 3,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    expect(output).toContain('/history 1');
    expect(output).toContain('上一页');
    expect(output).toContain('/history 3');
    expect(output).toContain('下一页');
  });

  it('最后一页只显示上一页提示', () => {
    const page: HistoryPage = {
      entries: [{ role: 'user', text: 'msg', timestamp: '2024-06-15T10:30:00Z' }],
      page: 3,
      totalPages: 3,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    expect(output).toContain('/history 2');
    expect(output).toContain('上一页');
    expect(output).not.toContain('下一页');
  });

  it('单页不显示翻页提示', () => {
    const page: HistoryPage = {
      entries: [{ role: 'user', text: 'msg', timestamp: '2024-06-15T10:30:00Z' }],
      page: 1,
      totalPages: 1,
      sessionId: 'sess12345678',
    };

    const output = formatHistoryPage(page);

    expect(output).not.toContain('下一页');
    expect(output).not.toContain('上一页');
  });
});

describe('getSessionList', () => {
  const workDir = '/home/user/project';
  const projectDir = '/mock-home/.claude/projects/-home-user-project';

  it('按时间倒序返回会话列表', async () => {
    mockReaddir.mockResolvedValue(['old.jsonl', 'new.jsonl'] as any);
    mockStat.mockImplementation(((p: string) => {
      if (String(p).includes('old.jsonl')) return Promise.resolve({ mtimeMs: 1000 });
      if (String(p).includes('new.jsonl')) return Promise.resolve({ mtimeMs: 2000 });
      return Promise.resolve({ mtimeMs: 0 });
    }) as any);
    mockReadFile.mockResolvedValue(userLine('hello'));

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0].sessionId).toBe('new');
    expect(result.data[1].sessionId).toBe('old');
    expect(result.data[0].mtime).toBe(2000);
    expect(result.data[1].mtime).toBe(1000);
  });

  it('最多返回 10 条', async () => {
    const files = Array.from({ length: 15 }, (_, i) => `session-${i}.jsonl`);
    mockReaddir.mockResolvedValue(files as any);
    mockStat.mockImplementation(((p: string) => {
      const match = String(p).match(/session-(\d+)\.jsonl/);
      const idx = match ? Number(match[1]) : 0;
      return Promise.resolve({ mtimeMs: idx * 1000 });
    }) as any);
    mockReadFile.mockResolvedValue(userLine('hello'));

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(10);
    // 最新的在前面
    expect(result.data[0].sessionId).toBe('session-14');
  });

  it('正确标记当前会话', async () => {
    mockReaddir.mockResolvedValue(['aaa.jsonl', 'bbb.jsonl'] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
    mockReadFile.mockResolvedValue(userLine('hello'));

    const result = await getSessionList(workDir, 'bbb');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const current = result.data.find(s => s.sessionId === 'bbb');
    const other = result.data.find(s => s.sessionId === 'aaa');
    expect(current?.isCurrent).toBe(true);
    expect(other?.isCurrent).toBe(false);
  });

  it('提取首条用户消息预览（超 100 字截断）', async () => {
    const longMsg = 'a'.repeat(150);
    const jsonl = [userLine(longMsg), assistantLine('reply')].join('\n');
    mockReaddir.mockResolvedValue(['sess.jsonl'] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
    mockReadFile.mockResolvedValue(jsonl);

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].preview).toBe('a'.repeat(100) + '...');
  });

  it('统计消息数量', async () => {
    const jsonl = [
      userLine('q1'),
      assistantLine('a1'),
      userLine('q2'),
      assistantLine('a2'),
      JSON.stringify({ type: 'system', message: { role: 'system', content: 'init' } }),
    ].join('\n');
    mockReaddir.mockResolvedValue(['sess.jsonl'] as any);
    mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);
    mockReadFile.mockResolvedValue(jsonl);

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].messageCount).toBe(4);
  });

  it('目录不存在时返回错误', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    const result = await getSessionList(workDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('当前工作区未找到会话记录。');
  });
});

describe('formatSessionList', () => {
  it('正确格式化会话列表', () => {
    const items: SessionListItem[] = [
      {
        sessionId: 'session-abc',
        mtime: new Date('2024-06-15T10:30:00Z').getTime(),
        messageCount: 5,
        preview: '你好，请帮我写一段代码',
        isCurrent: true,
      },
      {
        sessionId: 'session-def',
        mtime: new Date('2024-06-14T08:00:00Z').getTime(),
        messageCount: 12,
        preview: '分析一下这个 bug',
        isCurrent: false,
      },
    ];

    const output = formatSessionList(items);

    // 标题
    expect(output).toContain('📋 会话列表');
    // 编号
    expect(output).toContain('1.');
    expect(output).toContain('2.');
    // 消息数
    expect(output).toContain('5条');
    expect(output).toContain('12条');
    // 预览内容
    expect(output).toContain('你好，请帮我写一段代码');
    expect(output).toContain('分析一下这个 bug');
    // 当前会话标记
    expect(output).toContain('▶ 当前会话');
    // 使用提示
    expect(output).toContain('使用 /resume <序号> 恢复会话');
    // 日期格式 MM-DD HH:mm
    expect(output).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });
});
