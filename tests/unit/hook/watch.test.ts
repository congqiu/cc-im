import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerWatch,
  unregisterWatch,
  getWatchEntries,
  getWatchStatus,
  clearAllWatches,
  formatWatchNotify,
  muteSession,
  unmuteSession,
  type WatchEntry,
  type WatchNotifyData,
} from '../../../src/hook/watch.js';

describe('watch', () => {
  beforeEach(() => {
    clearAllWatches();
  });

  // ─── watchMap 增删查 ───

  describe('registerWatch / unregisterWatch / getEntries / getStatus', () => {
    it('注册后可以通过 getWatchEntries 查询', () => {
      const entry: WatchEntry = { chatId: 'chat1', platform: 'feishu', level: 'tool' };
      registerWatch('/home/user/project', entry);

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ chatId: 'chat1', platform: 'feishu', level: 'tool' });
    });

    it('注册后可以通过 getWatchStatus 查询', () => {
      const entry: WatchEntry = { chatId: 'chat1', platform: 'telegram', level: 'full' };
      registerWatch('/home/user/project', entry);

      const status = getWatchStatus('chat1');
      expect(status).toBeDefined();
      expect(status!.chatId).toBe('chat1');
      expect(status!.level).toBe('full');
      expect(status!.workDir).toBe('/home/user/project');
    });

    it('注销后查询不到', () => {
      const entry: WatchEntry = { chatId: 'chat1', platform: 'feishu', level: 'tool' };
      registerWatch('/home/user/project', entry);

      const result = unregisterWatch('/home/user/project', 'chat1');
      expect(result).toBe(true);

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(0);

      const status = getWatchStatus('chat1');
      expect(status).toBeUndefined();
    });

    it('注销不存在的 workDir 返回 false', () => {
      expect(unregisterWatch('/nonexistent', 'chat1')).toBe(false);
    });

    it('注销不存在的 chatId 返回 false', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });
      expect(unregisterWatch('/home/user/project', 'chat999')).toBe(false);
    });
  });

  // ─── 同一 chatId 更新 level ───

  describe('同一 chatId 更新 level', () => {
    it('同一 chatId 注册两次应更新 level 而非重复添加', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'stop' });
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'full' });

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('full');
    });

    it('同一 chatId 不同 threadId 应分别注册', () => {
      registerWatch('/home/user/project', {
        chatId: 'chat1',
        platform: 'feishu',
        level: 'stop',
        threadCtx: { rootMessageId: 'rm1', threadId: 't1' },
      });
      registerWatch('/home/user/project', {
        chatId: 'chat1',
        platform: 'feishu',
        level: 'full',
        threadCtx: { rootMessageId: 'rm2', threadId: 't2' },
      });

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(2);
    });
  });

  // ─── 多个 chatId 共存 ───

  describe('多个 chatId 共存', () => {
    it('同一 workDir 多个 chatId 应独立存在', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });
      registerWatch('/home/user/project', { chatId: 'chat2', platform: 'telegram', level: 'full' });

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.chatId).sort()).toEqual(['chat1', 'chat2']);
    });

    it('注销一个不影响另一个', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });
      registerWatch('/home/user/project', { chatId: 'chat2', platform: 'telegram', level: 'full' });

      unregisterWatch('/home/user/project', 'chat1');

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(1);
      expect(entries[0].chatId).toBe('chat2');
    });
  });

  // ─── threadId 精确匹配注销 ───

  describe('threadId 精确匹配注销', () => {
    it('带 threadId 的注销不影响无 threadId 的条目', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });
      registerWatch('/home/user/project', {
        chatId: 'chat1',
        platform: 'feishu',
        level: 'full',
        threadCtx: { rootMessageId: 'rm1', threadId: 't1' },
      });

      unregisterWatch('/home/user/project', 'chat1', 't1');

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(1);
      expect(entries[0].threadCtx).toBeUndefined();
    });

    it('无 threadId 的注销不影响带 threadId 的条目', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });
      registerWatch('/home/user/project', {
        chatId: 'chat1',
        platform: 'feishu',
        level: 'full',
        threadCtx: { rootMessageId: 'rm1', threadId: 't1' },
      });

      unregisterWatch('/home/user/project', 'chat1');

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(1);
      expect(entries[0].threadCtx?.threadId).toBe('t1');
    });
  });

  // ─── cwd 前缀匹配 ───

  describe('cwd 前缀匹配', () => {
    beforeEach(() => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });
    });

    it('精确匹配', () => {
      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(1);
    });

    it('子目录匹配', () => {
      const entries = getWatchEntries('/home/user/project/src/components');
      expect(entries).toHaveLength(1);
    });

    it('不匹配（不同路径）', () => {
      const entries = getWatchEntries('/home/user/other');
      expect(entries).toHaveLength(0);
    });

    it('不匹配（前缀相似但非子目录）', () => {
      const entries = getWatchEntries('/home/user/project-v2');
      expect(entries).toHaveLength(0);
    });
  });

  // ─── 事件级别过滤 ───

  describe('事件级别过滤', () => {
    it('stop 级别只匹配 Stop 事件', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'stop' });

      expect(getWatchEntries('/home/user/project', 'Stop')).toHaveLength(1);
      expect(getWatchEntries('/home/user/project', 'PostToolUse')).toHaveLength(0);
      expect(getWatchEntries('/home/user/project', 'SubagentStart')).toHaveLength(0);
      expect(getWatchEntries('/home/user/project', 'SubagentStop')).toHaveLength(0);
    });

    it('tool 级别匹配 PostToolUse 和 Stop', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });

      expect(getWatchEntries('/home/user/project', 'Stop')).toHaveLength(1);
      expect(getWatchEntries('/home/user/project', 'PostToolUse')).toHaveLength(1);
      expect(getWatchEntries('/home/user/project', 'SubagentStart')).toHaveLength(0);
      expect(getWatchEntries('/home/user/project', 'SubagentStop')).toHaveLength(0);
    });

    it('full 级别匹配所有事件', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'full' });

      expect(getWatchEntries('/home/user/project', 'Stop')).toHaveLength(1);
      expect(getWatchEntries('/home/user/project', 'PostToolUse')).toHaveLength(1);
      expect(getWatchEntries('/home/user/project', 'SubagentStart')).toHaveLength(1);
      expect(getWatchEntries('/home/user/project', 'SubagentStop')).toHaveLength(1);
    });

    it('不传事件名时返回所有条目（不过滤）', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'stop' });

      const entries = getWatchEntries('/home/user/project');
      expect(entries).toHaveLength(1);
    });
  });

  // ─── formatWatchNotify ───

  describe('formatWatchNotify', () => {
    it('PostToolUse - Bash', () => {
      const data: WatchNotifyData = {
        eventName: 'PostToolUse',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      };
      expect(formatWatchNotify(data)).toBe('🔧 Bash: npm test');
    });

    it('PostToolUse - Write', () => {
      const data: WatchNotifyData = {
        eventName: 'PostToolUse',
        toolName: 'Write',
        toolInput: { file_path: 'src/index.ts' },
      };
      expect(formatWatchNotify(data)).toBe('🔧 Write: src/index.ts');
    });

    it('PostToolUse - 无 toolInput', () => {
      const data: WatchNotifyData = {
        eventName: 'PostToolUse',
        toolName: 'CustomTool',
      };
      expect(formatWatchNotify(data)).toBe('🔧 CustomTool');
    });

    it('PostToolUse - 未知工具取第一个字符串值', () => {
      const data: WatchNotifyData = {
        eventName: 'PostToolUse',
        toolName: 'SomeTool',
        toolInput: { url: 'https://example.com', count: 5 },
      };
      expect(formatWatchNotify(data)).toBe('🔧 SomeTool: https://example.com');
    });

    it('Stop - 有预览消息', () => {
      const data: WatchNotifyData = {
        eventName: 'Stop',
        lastAssistantMessage: '任务已完成，生成了 3 个文件。',
      };
      expect(formatWatchNotify(data)).toBe('✅ Claude 已完成\n> 任务已完成，生成了 3 个文件。');
    });

    it('Stop - 无预览消息', () => {
      const data: WatchNotifyData = {
        eventName: 'Stop',
      };
      expect(formatWatchNotify(data)).toBe('✅ Claude 已完成');
    });

    it('SubagentStart', () => {
      const data: WatchNotifyData = {
        eventName: 'SubagentStart',
        agentType: 'Explore',
      };
      expect(formatWatchNotify(data)).toBe('🤖 子代理启动: Explore');
    });

    it('SubagentStop', () => {
      const data: WatchNotifyData = {
        eventName: 'SubagentStop',
        agentType: 'Explore',
      };
      expect(formatWatchNotify(data)).toBe('🤖 子代理完成: Explore');
    });
  });

  // ─── 长消息截断 ───

  describe('长消息截断', () => {
    it('Stop 预览超过 200 字应截断', () => {
      const longMessage = 'a'.repeat(300);
      const data: WatchNotifyData = {
        eventName: 'Stop',
        lastAssistantMessage: longMessage,
      };
      const result = formatWatchNotify(data);
      expect(result).toBe(`✅ Claude 已完成\n> ${'a'.repeat(200)}...`);
      // 确保不包含完整 300 字
      expect(result.length).toBeLessThan(300);
    });

    it('PostToolUse 工具参数超过 100 字应截断', () => {
      const longCommand = 'x'.repeat(150);
      const data: WatchNotifyData = {
        eventName: 'PostToolUse',
        toolName: 'Bash',
        toolInput: { command: longCommand },
      };
      const result = formatWatchNotify(data);
      expect(result).toBe(`🔧 Bash: ${'x'.repeat(100)}...`);
    });
  });

  // ─── session mute/unmute ───

  describe('session mute/unmute', () => {
    it('muted session 被过滤', () => {
      registerWatch('/work', { chatId: 'c1', platform: 'feishu', level: 'tool' });
      muteSession('/work', 'c1', 'a1b2');

      expect(getWatchEntries('/work', 'PostToolUse', 'xxxx-xxxx-a1b2')).toHaveLength(0);
      expect(getWatchEntries('/work', 'PostToolUse', 'xxxx-xxxx-c3d4')).toHaveLength(1);
    });

    it('unmute 后恢复接收', () => {
      registerWatch('/work', { chatId: 'c1', platform: 'feishu', level: 'tool' });
      muteSession('/work', 'c1', 'a1b2');
      unmuteSession('/work', 'c1', 'a1b2');

      expect(getWatchEntries('/work', 'PostToolUse', 'xxxx-xxxx-a1b2')).toHaveLength(1);
    });

    it('mute 未注册的监控返回 false', () => {
      expect(muteSession('/work', 'c1', 'a1b2')).toBe(false);
    });

    it('unmute 不存在的屏蔽返回 false', () => {
      registerWatch('/work', { chatId: 'c1', platform: 'feishu', level: 'tool' });
      expect(unmuteSession('/work', 'c1', 'nonexist')).toBe(false);
    });
  });

  // ─── sessionId 前缀 ───

  describe('sessionId 前缀', () => {
    it('有 sessionId 时显示后 4 位前缀', () => {
      const data: WatchNotifyData = {
        eventName: 'PostToolUse',
        sessionId: 'abcdef12345678',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      };
      expect(formatWatchNotify(data)).toBe('🔧 [5678] Bash: ls');
    });

    it('Stop 事件也带 sessionId 前缀', () => {
      const data: WatchNotifyData = {
        eventName: 'Stop',
        sessionId: 'abcdef12345678',
        lastAssistantMessage: 'done',
      };
      expect(formatWatchNotify(data)).toContain('[5678]');
      expect(formatWatchNotify(data)).toContain('done');
    });

    it('无 sessionId 时不显示前缀', () => {
      const data: WatchNotifyData = {
        eventName: 'PostToolUse',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      };
      expect(formatWatchNotify(data)).toBe('🔧 Bash: ls');
    });
  });

  // ─── clearAllWatches ───

  describe('clearAllWatches', () => {
    it('清空后所有查询都为空', () => {
      registerWatch('/home/user/project', { chatId: 'chat1', platform: 'feishu', level: 'tool' });
      registerWatch('/home/user/other', { chatId: 'chat2', platform: 'telegram', level: 'full' });

      clearAllWatches();

      expect(getWatchEntries('/home/user/project')).toHaveLength(0);
      expect(getWatchEntries('/home/user/other')).toHaveLength(0);
      expect(getWatchStatus('chat1')).toBeUndefined();
      expect(getWatchStatus('chat2')).toBeUndefined();
    });
  });
});
