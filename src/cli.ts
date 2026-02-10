#!/usr/bin/env node
import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

const DATA_DIR = join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.cc-bot');
const PID_FILE = join(DATA_DIR, 'pid');

function getPidFromFile() {
  if (existsSync(PID_FILE)) {
    try {
      return parseInt(readFileSync(PID_FILE, 'utf-8'), 10);
    } catch {
      return null;
    }
  }
  return null;
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stop() {
  const pid = getPidFromFile();

  if (pid && isRunning(pid)) {
    try {
      process.kill(pid);
      console.log(`已停止服务 (PID: ${pid})`);
    } catch (e: unknown) {
      const error = e as Error;
      console.error('停止失败:', error.message);
      process.exit(1);
    }
  } else {
    console.log('服务未运行');
  }

  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

async function start() {
  const pid = getPidFromFile();
  if (pid && isRunning(pid)) {
    console.log(`服务已在运行中 (PID: ${pid})`);
    console.log(`请先运行: cc-bot stop`);
    process.exit(1);
  }

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  writeFileSync(PID_FILE, String(process.pid));

  try {
    const { main } = await import('./index.js');
    await main();
  } finally {
    if (existsSync(PID_FILE)) {
      unlinkSync(PID_FILE);
    }
  }
}

const command = process.argv[2];

if (command === 'stop') {
  await stop();
} else {
  await start();
}
