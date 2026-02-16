import { describe, it, expect } from 'vitest';
import { truncateForCard, buildCard, splitLongContent } from '../../../src/feishu/card-builder.js';

describe('Card Builder', () => {
  describe('truncateForCard', () => {
    it('短文本不截断', () => {
      const text = 'Short text';
      expect(truncateForCard(text)).toBe(text);
    });

    it('长文本截断保留尾部', () => {
      const text = 'a'.repeat(4000);
      const result = truncateForCard(text);
      expect(result.length).toBeLessThanOrEqual(3800);
      expect(result).toContain('...(前文已省略)...');
    });

    it('在换行符处截断', () => {
      const text = 'a'.repeat(3000) + '\n' + 'b'.repeat(2000);
      const result = truncateForCard(text);
      expect(result).toContain('\n');
      expect(result).toContain('...(前文已省略)...');
    });

    it('无换行的长文本直接截断', () => {
      const text = 'x'.repeat(5000);
      const result = truncateForCard(text);
      expect(result.length).toBeLessThanOrEqual(3800);
    });
  });

  describe('buildCard', () => {
    it('生成 thinking 状态卡片', () => {
      const card = buildCard(
        { content: 'Thinking...', status: 'thinking', note: 'Please wait' },
        'msg-123'
      );
      const parsed = JSON.parse(card);
      expect(parsed.header.template).toBe('blue');
      expect(parsed.header.title.content).toContain('思考中');
      expect(parsed.elements).toHaveLength(3); // markdown + note + action
      expect(parsed.elements[2].tag).toBe('action');
      expect(parsed.elements[2].actions[0].text.content).toContain('停止');
    });

    it('生成 streaming 状态卡片', () => {
      const card = buildCard(
        { content: 'Output...', status: 'streaming' },
        'msg-456'
      );
      const parsed = JSON.parse(card);
      expect(parsed.header.template).toBe('blue');
      expect(parsed.elements).toHaveLength(2); // markdown + action (无 note)
    });

    it('生成 done 状态卡片', () => {
      const card = buildCard(
        { content: 'Completed', status: 'done', note: 'Cost $0.01' },
        'msg-789'
      );
      const parsed = JSON.parse(card);
      expect(parsed.header.template).toBe('green');
      expect(parsed.elements).toHaveLength(2); // markdown + note (无停止按钮)
      expect(parsed.elements.some((el: any) => el.tag === 'action')).toBe(false);
    });

    it('生成 error 状态卡片', () => {
      const card = buildCard(
        { content: 'Error occurred', status: 'error', note: 'Failed' }
      );
      const parsed = JSON.parse(card);
      expect(parsed.header.template).toBe('red');
      expect(parsed.header.title.content).toContain('错误');
      expect(parsed.elements).toHaveLength(2); // markdown + note
    });

    it('无 messageId 时不含停止按钮', () => {
      const card = buildCard(
        { content: 'Thinking', status: 'thinking' }
      );
      const parsed = JSON.parse(card);
      const hasActionButton = parsed.elements.some((el: any) => el.tag === 'action');
      expect(hasActionButton).toBe(false);
    });

    it('包含 note 元素', () => {
      const card = buildCard(
        { content: 'Test', status: 'done', note: 'Test note' }
      );
      const parsed = JSON.parse(card);
      const noteElement = parsed.elements.find((el: any) => el.tag === 'note');
      expect(noteElement).toBeDefined();
      expect(noteElement.elements[0].content).toBe('Test note');
    });

    it('空内容显示 "..."', () => {
      const card = buildCard({ content: '', status: 'thinking' });
      const parsed = JSON.parse(card);
      expect(parsed.elements[0].content).toBe('...');
    });

    it('停止按钮的 value 格式正确', () => {
      const messageId = 'test-msg-123';
      const card = buildCard(
        { content: 'Running', status: 'streaming' },
        messageId
      );
      const parsed = JSON.parse(card);
      const actionElement = parsed.elements.find((el: any) => el.tag === 'action');
      const buttonValue = actionElement.actions[0].value;
      expect(buttonValue).toEqual({ action: 'stop', message_id: messageId });
    });
  });

  describe('splitLongContent', () => {
    it('短内容不分片', () => {
      const text = 'Short content';
      const parts = splitLongContent(text);
      expect(parts).toHaveLength(1);
      expect(parts[0]).toBe(text);
    });

    it('长内容在换行处分片', () => {
      const text = 'a'.repeat(3000) + '\n' + 'b'.repeat(3000);
      const parts = splitLongContent(text, 3800);
      expect(parts.length).toBeGreaterThan(1);
      parts.forEach((part) => {
        expect(part.length).toBeLessThanOrEqual(3800);
      });
    });

    it('无换行的长内容硬切', () => {
      const text = 'x'.repeat(8000);
      const parts = splitLongContent(text, 3800);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts[0].length).toBeLessThanOrEqual(3800);
    });

    it('自定义 maxLen', () => {
      const text = 'a'.repeat(1500);
      const parts = splitLongContent(text, 1000);
      expect(parts.length).toBeGreaterThan(1);
      parts.forEach((part) => {
        expect(part.length).toBeLessThanOrEqual(1000);
      });
    });

    it('分片后拼接应该等于原文本', () => {
      const text = 'Line1\n'.repeat(1000);
      const parts = splitLongContent(text, 2000);
      const rejoined = parts.join('');
      expect(rejoined).toBe(text);
    });
  });
});
