#!/usr/bin/env node

/**
 * Claude Code Hook 脚本 — watch 通知
 *
 * 适用于 PostToolUse / Stop / SubagentStart / SubagentStop 等事件。
 * 从 stdin 读取事件数据，POST 到 cc-im 服务端的 /watch-notify 端点。
 *
 * 关键原则：永远不阻塞 Claude Code，所有错误静默处理，始终 exit 0。
 *
 * 环境变量：
 *   CC_IM_HOOK_PORT - 本地服务端口（默认 18900）
 *
 * stdin: JSON { hook_event_name, cwd, tool_name, tool_input, tool_response, last_assistant_message, agent_type }
 */

import { request } from 'node:http';

// 定义在本文件而非 constants.ts，因为 watch-script 作为独立 hook 脚本由 Claude Code 直接执行，
// 需要最小化依赖以保持快速启动。
const WATCH_NOTIFY_TIMEOUT_MS = 2000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // If stdin is empty/closed immediately
    setTimeout(() => resolve(data), 100);
  });
}

function httpPost(port: number, path: string, body: unknown): Promise<void> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: WATCH_NOTIFY_TIMEOUT_MS,
    }, (res) => {
      // Drain response
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

async function main(): Promise<void> {
  const port = parseInt(process.env.CC_IM_HOOK_PORT ?? '18900', 10);

  let input: {
    hook_event_name?: string;
    session_id?: string;
    cwd?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: string;
    last_assistant_message?: string;
    agent_type?: string;
  };

  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // 无法解析输入，静默退出
    process.exit(0);
  }

  const eventName = input.hook_event_name;
  if (!eventName) {
    process.exit(0);
  }

  await httpPost(port, '/watch-notify', {
    eventName,
    sessionId: input.session_id,
    cwd: input.cwd ?? process.cwd(),
    toolName: input.tool_name,
    toolInput: input.tool_input,
    toolResponse: input.tool_response,
    lastAssistantMessage: input.last_assistant_message,
    agentType: input.agent_type,
  });

  process.exit(0);
}

/* c8 ignore next 3 */
const isDirectRun = process.argv[1]?.endsWith('watch-script.js');
if (isDirectRun) main();

export { main, readStdin, httpPost };
