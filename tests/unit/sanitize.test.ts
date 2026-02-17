import { describe, it, expect } from 'vitest';
import { sanitize } from '../../src/sanitize.js';

describe('sanitize', () => {
  describe('飞书 open_id 脱敏', () => {
    it('应该脱敏 open_id', () => {
      const input = 'User ou_abc123def456 sent a message';
      const output = sanitize(input);
      expect(output).toBe('User ou_abc1**** sent a message');
    });

    it('应该脱敏多个 open_id', () => {
      const input = 'ou_user1234567 and ou_user7654321';
      const output = sanitize(input);
      expect(output).toContain('ou_user****');
      expect(output).toBe('ou_user**** and ou_user****');
    });
  });

  describe('UUID 脱敏', () => {
    it('应该脱敏 UUID', () => {
      const input = 'Session: 550e8400-e29b-41d4-a716-446655440000';
      const output = sanitize(input);
      expect(output).toBe('Session: ****0000');
    });
  });

  describe('路径脱敏', () => {
    it('应该脱敏 /home 路径', () => {
      const input = 'File at /home/user/projects/myapp/src/index.ts';
      const output = sanitize(input);
      expect(output).toBe('File at .../src/index.ts');
    });

    it('应该脱敏 /root 路径', () => {
      const input = '/root/workspace/project/file.txt';
      const output = sanitize(input);
      expect(output).toBe('.../project/file.txt');
    });

    it('应该保留短路径', () => {
      const input = '/home/user';
      const output = sanitize(input);
      expect(output).toBe('/home/user');
    });
  });

  describe('Token 脱敏', () => {
    it('应该脱敏 sk_ token', () => {
      const input = 'API key: sk_test_1234567890abcdef';
      const output = sanitize(input);
      expect(output).toBe('API key: sk_****');
    });

    it('应该脱敏 pk_ token', () => {
      const input = 'Public key: pk_live_abcdefghijklmnop';
      const output = sanitize(input);
      expect(output).toBe('Public key: pk_****');
    });

    it('应该脱敏 bot_ token', () => {
      const input = 'Bot token: bot_1234567890_abcdefghijklmnop';
      const output = sanitize(input);
      expect(output).toBe('Bot token: bot_****');
    });

    it('应该脱敏 xoxb- Slack token', () => {
      const input = 'Slack: xoxb-1234567890-1234567890-abcdefghijklmnop';
      const output = sanitize(input);
      expect(output).toBe('Slack: xoxb_****');
    });

    it('应该脱敏 xoxp- Slack token', () => {
      const input = 'Token: xoxp-1234567890-1234567890-abcdefghijklmnop';
      const output = sanitize(input);
      expect(output).toBe('Token: xoxp_****');
    });

    it('Token 脱敏应该不区分大小写', () => {
      const input = 'Keys: SK_TEST_123 and PK_LIVE_456';
      const output = sanitize(input);
      expect(output).toContain('SK_****');
      expect(output).toContain('PK_****');
    });

    it('不应该误匹配短字符串', () => {
      const input = 'skip_this and pk_ab and bot_id';
      const output = sanitize(input);
      expect(output).toBe(input);
    });
  });

  describe('API Key 脱敏', () => {
    it('应该脱敏 Google API key (AIza)', () => {
      const input = 'Google key: AIzaSyD1234567890abcdefghijklmnop';
      const output = sanitize(input);
      expect(output).toBe('Google key: AIza****');
    });

    it('应该脱敏 AWS Access Key (AKIA)', () => {
      const input = 'AWS: AKIAIOSFODNN7EXAMPLE';
      const output = sanitize(input);
      expect(output).toBe('AWS: AKIA****');
    });

    it('应该脱敏其他 AWS key 前缀', () => {
      const input = 'Keys: AGPA1234567890AB, AIDA1234567890AB, AROA1234567890AB';
      const output = sanitize(input);
      expect(output).toContain('AGPA****');
      expect(output).toContain('AIDA****');
      expect(output).toContain('AROA****');
    });
  });

  describe('密码字段脱敏', () => {
    it('应该脱敏 JSON password 字段', () => {
      const input = '{"username":"admin","password":"secret123"}';
      const output = sanitize(input);
      expect(output).toBe('{"username":"admin","password":"****"}');
    });

    it('应该脱敏 passwd 字段', () => {
      const input = '{"user":"root","passwd":"mypassword"}';
      const output = sanitize(input);
      expect(output).toBe('{"user":"root","passwd":"****"}');
    });

    it('应该脱敏 pwd 字段', () => {
      const input = '{"login":"user","pwd":"12345"}';
      const output = sanitize(input);
      expect(output).toBe('{"login":"user","pwd":"****"}');
    });

    it('应该脱敏 secret 字段', () => {
      const input = '{"app":"myapp","secret":"topsecret"}';
      const output = sanitize(input);
      expect(output).toBe('{"app":"myapp","secret":"****"}');
    });

    it('应该脱敏 token 字段', () => {
      const input = '{"service":"api","token":"abc123"}';
      const output = sanitize(input);
      expect(output).toBe('{"service":"api","token":"****"}');
    });

    it('应该脱敏 apikey 字段', () => {
      const input = '{"name":"test","apikey":"key123"}';
      const output = sanitize(input);
      expect(output).toBe('{"name":"test","apikey":"****"}');
    });

    it('应该脱敏 api_key 字段', () => {
      const input = '{"service":"api","api_key":"mykey"}';
      const output = sanitize(input);
      expect(output).toBe('{"service":"api","api_key":"****"}');
    });

    it('密码字段脱敏应该不区分大小写', () => {
      const input = '{"Password":"secret","API_KEY":"key"}';
      const output = sanitize(input);
      expect(output).toContain('"Password":"****"');
      expect(output).toContain('"API_KEY":"****"');
    });
  });

  describe('综合测试', () => {
    it('应该同时脱敏多种敏感信息', () => {
      const input = `
        User ou_abc123def456 logged in from /home/user/workspace
        Session: 550e8400-e29b-41d4-a716-446655440000
        API key: sk_test_1234567890abcdef
        Config: {"password":"secret","token":"abc123"}
      `;
      const output = sanitize(input);

      expect(output).toContain('ou_abc1****');
      expect(output).toContain('.../user/workspace');
      expect(output).toContain('****0000');
      expect(output).toContain('sk_****');
      expect(output).toContain('"password":"****"');
      expect(output).toContain('"token":"****"');
    });

    it('不应该修改普通文本', () => {
      const input = 'This is a normal message without sensitive data';
      const output = sanitize(input);
      expect(output).toBe(input);
    });
  });
});
