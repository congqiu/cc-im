#!/usr/bin/env node

/**
 * Claude Code PreToolUse hook script.
 *
 * This script is invoked by Claude Code before each tool execution.
 * It sends a permission request to the cc-bot permission server,
 * which notifies the user via the messaging platform and waits for their decision.
 *
 * Environment variables:
 *   CC_BOT_CHAT_ID   - Chat ID to send the permission card to
 *   CC_BOT_HOOK_PORT - Port of the local permission server (default: 18900)
 *
 * stdin: JSON { session_id, tool_name, tool_input }
 * stdout: JSON { permissionDecision: "allow" | "deny" }
 *
 * Exit codes:
 *   0 - Success (decision written to stdout)
 *   1 - General error (input parsing failed, etc.)
 *   2 - Permission server unreachable (deny decision written to stdout)
 */

import { request } from 'node:http';
import { READ_ONLY_TOOLS, HOOK_EXIT_CODES } from '../constants.js';

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

function httpPost(port: number, path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
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
      timeout: 6 * 60 * 1000, // 6 minutes (server has 5 min timeout)
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 500, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 500, data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

async function main() {
  const chatId = process.env.CC_BOT_CHAT_ID;
  const port = parseInt(process.env.CC_BOT_HOOK_PORT ?? '18900', 10);

  // No chat ID configured - allow by default and exit
  if (!chatId) {
    // Output allow decision to maintain consistency with hook protocol
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    process.exit(HOOK_EXIT_CODES.SUCCESS);
  }

  let input: { tool_name?: string; tool_input?: Record<string, unknown> };
  try {
    const raw = await readStdin();
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    // Cannot parse input - allow by default to avoid blocking legitimate operations
    process.stderr.write(`Warning: Failed to parse hook input, allowing by default: ${err}\n`);
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    process.exit(HOOK_EXIT_CODES.SUCCESS);
  }

  const toolName = input.tool_name ?? 'unknown';
  const toolInput = input.tool_input ?? {};

  // Skip permission check for read-only tools - allow immediately
  if (READ_ONLY_TOOLS.includes(toolName)) {
    process.stdout.write(JSON.stringify({ permissionDecision: 'allow' }));
    process.exit(HOOK_EXIT_CODES.SUCCESS);
  }

  try {
    const result = await httpPost(port, '/permission-request', {
      chatId,
      toolName,
      toolInput,
    });

    const data = result.data as { decision?: string };
    const decision = data?.decision ?? 'deny';

    // Output the decision as JSON to stdout
    const output = JSON.stringify({ permissionDecision: decision === 'allow' ? 'allow' : 'deny' });
    process.stdout.write(output);
    process.exit(HOOK_EXIT_CODES.SUCCESS);
  } catch (err) {
    // Permission server is not reachable - deny by default for security
    // Output deny decision to stdout so Claude Code can proceed (rather than hanging)
    const errorMessage = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: Permission server unreachable (port ${port}): ${errorMessage}\n`);
    process.stderr.write('Denying operation by default for security. Please check if cc-bot is running.\n');

    // Write deny decision to stdout
    process.stdout.write(JSON.stringify({ permissionDecision: 'deny' }));
    process.exit(HOOK_EXIT_CODES.PERMISSION_SERVER_ERROR);
  }
}

main();
