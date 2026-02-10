#!/usr/bin/env node
import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, openSync, closeSync } from 'fs';
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
  // 先检查旧的 PID 文件
  const oldPid = getPidFromFile();
  if (oldPid && isRunning(oldPid)) {
    console.log(`服务已在运行中 (PID: ${oldPid})`);
    console.log(`请先运行: cc-bot stop`);
    process.exit(1);
  }

  // 清理失效的 PID 文件
  if (oldPid && !isRunning(oldPid) && existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }

  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  // 使用 exclusive 模式写入 PID 文件，防止竞态条件
  let fd: number | null = null;
  try {
    // 'wx' 模式：如果文件存在会抛出错误，原子操作
    fd = openSync(PID_FILE, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    fd = null;
  } catch (err: unknown) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EEXIST') {
      console.error('服务正在启动中或 PID 文件被锁定，请稍后再试');
      process.exit(1);
    }
    throw err;
  }

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
