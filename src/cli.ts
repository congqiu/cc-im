#!/usr/bin/env node
import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, openSync, closeSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import { createLogger } from './logger.js';
import { APP_HOME } from './constants.js';

const PID_FILE = join(APP_HOME, 'pid');
const LOG_DIR = join(APP_HOME, 'logs');
const logger = createLogger('CLI');

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
      logger.info(`已停止服务 (PID: ${pid})`);
    } catch (e: unknown) {
      const error = e as Error;
      logger.error('停止失败:', error.message);
      process.exit(1);
    }
  } else {
    logger.info('服务未运行');
  }

  if (existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }
}

async function start() {
  // 先检查旧的 PID 文件
  const oldPid = getPidFromFile();
  if (oldPid && isRunning(oldPid)) {
    logger.info(`服务已在运行中 (PID: ${oldPid})`);
    logger.info(`请先运行: cc-im stop`);
    process.exit(1);
  }

  // 清理失效的 PID 文件
  if (oldPid && !isRunning(oldPid) && existsSync(PID_FILE)) {
    unlinkSync(PID_FILE);
  }

  if (!existsSync(APP_HOME)) {
    mkdirSync(APP_HOME, { recursive: true });
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
      try { closeSync(fd); } catch (e) { logger.debug('closeSync cleanup failed:', e); }
    }
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EEXIST') {
      logger.error('服务正在启动中或 PID 文件被锁定，请稍后再试');
      process.exit(1);
    }
    throw err;
  }

  // 进程退出时清理 PID 文件
  const cleanupPid = () => {
    try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch (e) { logger.debug('PID file cleanup failed:', e); }
  };
  process.on('exit', cleanupPid);

  const { main } = await import('./index.js');
  await main();
}

function parseArgs() {
  const args = process.argv.slice(2);
  let command = 'start';
  let daemon = false;

  for (const arg of args) {
    if (arg === 'stop') {
      command = 'stop';
    } else if (arg === '-d' || arg === '--daemon') {
      daemon = true;
    }
  }

  return { command, daemon };
}

function startDaemon() {
  // 检查是否已在运行
  const oldPid = getPidFromFile();
  if (oldPid && isRunning(oldPid)) {
    logger.info(`服务已在运行中 (PID: ${oldPid})`);
    logger.info(`请先运行: cc-im stop`);
    process.exit(1);
  }

  mkdirSync(LOG_DIR, { recursive: true });

  const outLog = join(LOG_DIR, 'daemon.log');
  const outFd = openSync(outLog, 'a');

  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: process.env,
  });

  child.unref();
  closeSync(outFd);

  logger.info(`服务已在后台启动 (PID: ${child.pid})`);
  logger.info(`日志文件: ${outLog}`);
  logger.info(`停止服务: cc-im stop`);
}

const { command, daemon } = parseArgs();

if (command === 'stop') {
  await stop();
} else if (daemon) {
  startDaemon();
} else {
  await start();
}
