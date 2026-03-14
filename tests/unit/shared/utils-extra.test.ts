import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Must import after mock
import { formatToolCallNotification, getContextWarning, truncateText } from '../../../src/shared/utils.js';

describe('formatToolCallNotification', () => {
  it('无 toolInput 时只显示工具名', () => {
    expect(formatToolCallNotification('Read')).toBe('📖 Read');
  });

  it('Edit 显示文件路径和行数变化', () => {
    const result = formatToolCallNotification('Edit', {
      file_path: '/src/main.ts',
      old_string: 'line1\nline2',
      new_string: 'line1\nline2\nline3',
    });
    expect(result).toContain('/src/main.ts');
    expect(result).toContain('-2/+3');
  });

  it('Read 显示文件路径和行范围', () => {
    const result = formatToolCallNotification('Read', {
      file_path: '/src/main.ts',
      offset: 10,
      limit: 50,
    });
    expect(result).toContain('/src/main.ts');
    expect(result).toContain('L10');
    expect(result).toContain('50行');
  });

  it('Read 无 file_path 时不显示详情', () => {
    const result = formatToolCallNotification('Read', {});
    expect(result).toBe('📖 Read');
  });

  it('Write 显示文件路径和字符数', () => {
    const result = formatToolCallNotification('Write', {
      file_path: '/tmp/out.txt',
      content: 'hello world',
    });
    expect(result).toContain('/tmp/out.txt');
    expect(result).toContain('11字符');
  });

  it('Bash 显示命令', () => {
    const result = formatToolCallNotification('Bash', { command: 'ls -la' });
    expect(result).toContain('ls -la');
  });

  it('Bash 长命令被截断', () => {
    const longCmd = 'x'.repeat(100);
    const result = formatToolCallNotification('Bash', { command: longCmd });
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(120);
  });

  it('Grep 显示 pattern', () => {
    const result = formatToolCallNotification('Grep', { pattern: 'TODO' });
    expect(result).toContain('TODO');
  });

  it('Glob 显示 pattern', () => {
    const result = formatToolCallNotification('Glob', { pattern: '**/*.ts' });
    expect(result).toContain('**/*.ts');
  });

  it('WebFetch 显示 URL', () => {
    const result = formatToolCallNotification('WebFetch', { url: 'https://example.com' });
    expect(result).toContain('https://example.com');
  });

  it('WebSearch 显示 query', () => {
    const result = formatToolCallNotification('WebSearch', { query: 'vitest coverage' });
    expect(result).toContain('vitest coverage');
  });

  it('Task 显示 description', () => {
    const result = formatToolCallNotification('Task', { description: 'Run tests' });
    expect(result).toContain('Run tests');
  });

  it('Agent 显示 prompt 摘要', () => {
    const result = formatToolCallNotification('Agent', { prompt: 'Review the code changes' });
    expect(result).toBe('🤖 Agent → Review the code changes');
  });

  it('Agent 长 prompt 被截断', () => {
    const result = formatToolCallNotification('Agent', { prompt: 'x'.repeat(100) });
    expect(result).toContain('...');
  });

  it('Agent 无 prompt 时使用 description', () => {
    const result = formatToolCallNotification('Agent', { description: 'Code review' });
    expect(result).toBe('🤖 Agent → Code review');
  });

  it('Skill 显示 skill 名称', () => {
    const result = formatToolCallNotification('Skill', { skill: 'commit' });
    expect(result).toBe('⚡ Skill → commit');
  });

  it('未知工具显示默认 emoji', () => {
    const result = formatToolCallNotification('CustomTool', { key: 'val' });
    expect(result).toBe('🔧 CustomTool');
  });
});

describe('getContextWarning', () => {
  it('轮次 < 8 返回 null', () => {
    expect(getContextWarning(5)).toBeNull();
    expect(getContextWarning(7)).toBeNull();
  });

  it('轮次 8-11 返回 compact 建议', () => {
    const msg = getContextWarning(8);
    expect(msg).toContain('/compact');
    expect(msg).toContain('8');
  });

  it('轮次 >= 12 返回 /new 建议', () => {
    const msg = getContextWarning(12);
    expect(msg).toContain('/new');
    expect(msg).toContain('/compact');
  });
});

describe('truncateText', () => {
  it('短文本不截断', () => {
    expect(truncateText('hello', 100)).toBe('hello');
  });

  it('超长文本截断并保留尾部', () => {
    const text = 'a'.repeat(200);
    const result = truncateText(text, 100);
    expect(result.length).toBeLessThanOrEqual(110); // with prefix
    expect(result).toContain('前文已省略');
  });

  it('在换行符处截断', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateText(lines, 100);
    expect(result).toContain('前文已省略');
    // Should break at a newline
    expect(result).toMatch(/\nline \d+/);
  });
});