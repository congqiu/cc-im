import { describe, it, expect } from 'vitest';
import { splitLongContent, buildInputSummary, trackCost, formatToolStats } from '../../../src/shared/utils.js';
import type { CostRecord } from '../../../src/shared/types.js';

describe('splitLongContent', () => {
  it('短文本不分割', () => {
    expect(splitLongContent('hello', 100)).toEqual(['hello']);
  });

  it('按最大长度分割', () => {
    const text = 'a'.repeat(250);
    const parts = splitLongContent(text, 100);
    expect(parts.length).toBe(3);
    expect(parts.join('')).toBe(text);
  });

  it('优先在换行符处分割', () => {
    const text = 'line1\n' + 'a'.repeat(90) + '\nline3';
    const parts = splitLongContent(text, 100);
    expect(parts[0]).toBe('line1\n' + 'a'.repeat(90) + '\n');
    expect(parts[1]).toBe('line3');
  });

  it('空文本返回单元素数组', () => {
    expect(splitLongContent('', 100)).toEqual(['']);
  });
});

describe('buildInputSummary', () => {
  it('Bash 命令显示 command', () => {
    expect(buildInputSummary('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('Write 显示文件路径和内容长度', () => {
    const result = buildInputSummary('Write', { file_path: '/tmp/test.txt', content: 'hello' });
    expect(result).toContain('/tmp/test.txt');
    expect(result).toContain('5 字符');
  });

  it('Edit 显示文件路径', () => {
    expect(buildInputSummary('Edit', { file_path: '/tmp/test.txt' })).toBe('文件: /tmp/test.txt');
  });

  it('无参数显示提示', () => {
    expect(buildInputSummary('Unknown', {})).toBe('(无参数)');
  });

  it('其他工具显示 key-value 摘要', () => {
    const result = buildInputSummary('Custom', { key1: 'val1', key2: 'val2' });
    expect(result).toContain('key1: val1');
    expect(result).toContain('key2: val2');
  });

  it('长值被截断到 200 字符', () => {
    const longVal = 'x'.repeat(300);
    const result = buildInputSummary('Custom', { key: longVal });
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(300);
  });

  it('最多显示 5 个 key', () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) input[`k${i}`] = `v${i}`;
    const result = buildInputSummary('Custom', input);
    const lines = result.split('\n');
    expect(lines.length).toBe(5);
  });
});

describe('formatToolStats', () => {
  it('无工具调用返回空字符串', () => {
    expect(formatToolStats({}, 0)).toBe('');
  });

  it('单个工具', () => {
    expect(formatToolStats({ Read: 3 }, 2)).toBe('2 轮 3 次工具（Read×3）');
  });

  it('多个工具按次数降序', () => {
    const result = formatToolStats({ Read: 2, Bash: 5, Edit: 1 }, 4);
    expect(result).toBe('4 轮 8 次工具（Bash×5 Read×2 Edit×1）');
  });
});

describe('trackCost', () => {
  it('新用户创建记录', () => {
    const costs = new Map<string, CostRecord>();
    trackCost(costs, 'user1', 0.5, 1000);
    const record = costs.get('user1')!;
    expect(record.totalCost).toBe(0.5);
    expect(record.totalDurationMs).toBe(1000);
    expect(record.requestCount).toBe(1);
  });

  it('累积多次费用', () => {
    const costs = new Map<string, CostRecord>();
    trackCost(costs, 'user1', 0.5, 1000);
    trackCost(costs, 'user1', 0.3, 2000);
    const record = costs.get('user1')!;
    expect(record.totalCost).toBeCloseTo(0.8);
    expect(record.totalDurationMs).toBe(3000);
    expect(record.requestCount).toBe(2);
  });
});
