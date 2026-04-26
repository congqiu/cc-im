import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules before import
vi.mock('node:http', () => ({
  request: vi.fn(),
}));

vi.mock('../../../src/constants.js', () => ({
  READ_ONLY_TOOLS: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoRead'],
  HOOK_EXIT_CODES: { SUCCESS: 0, ERROR: 1, PERMISSION_SERVER_ERROR: 2 },
}));

import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';

describe('hook-script', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let _stdoutWrite: ReturnType<typeof vi.spyOn>;
  let _stderrWrite: ReturnType<typeof vi.spyOn>;
  let _processExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    _stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    _stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _processExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  async function importMain() {
    const mod = await import('../../../src/hook/hook-script.js');
    return mod;
  }

  function mockHttpResponse(statusCode: number, body: string) {
    const mockReq = {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ClientRequest;

    vi.mocked(request).mockImplementation((_opts, callback) => {
      const res = {
        statusCode,
        on: vi.fn((event: string, handler: (chunk?: string) => void) => {
          if (event === 'data') handler(body);
          if (event === 'end') handler();
          return res;
        }),
      } as unknown as IncomingMessage;
      (callback as (res: IncomingMessage) => void)(res);
      return mockReq;
    });

    return mockReq;
  }

  describe('只读工具自动放行', () => {
    it('Read 工具应在只读列表中', async () => {
      const { READ_ONLY_TOOLS } = await import('../../../src/constants.js');
      expect(READ_ONLY_TOOLS).toContain('Read');
      expect(READ_ONLY_TOOLS).toContain('Glob');
      expect(READ_ONLY_TOOLS).toContain('Grep');
    });
  });

  describe('httpPost', () => {
    it('成功时返回响应', async () => {
      mockHttpResponse(200, '{"decision":"allow"}');
      const { httpPost } = await importMain();

      const result = await httpPost(18900, '/permission-request', { chatId: 'test' });
      expect(result.status).toBe(200);
      expect(result.data).toEqual({ decision: 'allow' });
    });

    it('服务器不可达时 reject', async () => {
      const mockReq = {
        on: vi.fn((event: string, handler: (err: Error) => void) => {
          if (event === 'error') handler(new Error('ECONNREFUSED'));
          return mockReq;
        }),
        write: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      } as unknown as ClientRequest;

      vi.mocked(request).mockReturnValue(mockReq);
      const { httpPost } = await importMain();

      await expect(httpPost(18900, '/test', {})).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('codex permission request output', () => {
    it('returns codex allow payload for PermissionRequest', async () => {
      process.env.CC_IM_AGENT_PROVIDER = 'codex';
      process.env.CC_IM_CHAT_ID = 'chat-1';
      mockHttpResponse(200, '{"decision":"allow"}');

      const { main } = await importMain();

      await expect(main(async () => JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }))).rejects.toThrow('process.exit');
      expect(_stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('"hookEventName":"PermissionRequest"'));
      expect(_stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('"behavior":"allow"'));
    });
  });
});
