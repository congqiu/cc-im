#!/usr/bin/env node
import { join } from 'path';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, openSync, closeSync, statSync, renameSync } from 'fs';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

import { createLogger } from './logger.js';
import { APP_HOME } from './constants.js';

const PID_FILE = join(APP_HOME, 'pid');
const LOG_DIR = join(APP_HOME, 'logs');
const SERVICE_NAME = 'cc-im';
const SERVICE_DIR = join(homedir(), '.config', 'systemd', 'user');
const SERVICE_FILE = join(SERVICE_DIR, `${SERVICE_NAME}.service`);
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
  // 优先停 systemd 服务
  if (isSystemdActive()) {
    systemctl('stop', SERVICE_NAME);
    logger.info('已停止 systemd 服务');
    return;
  }

  // 其次停守护进程
  const pid = getPidFromFile();
  if (pid && isRunning(pid)) {
    try {
      process.kill(pid);
      logger.info(`已停止守护进程 (PID: ${pid})`);
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

function generateServiceContent() {
  const scriptPath = fileURLToPath(import.meta.url);
  // dist/cli.js -> project root
  const projectDir = join(scriptPath, '..', '..');
  const nodeBinDir = join(process.execPath, '..');
  return `[Unit]
Description=CC-IM Bot Bridge Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectDir}
ExecStart=${process.execPath} ${join(projectDir, 'dist', 'index.js')}
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${nodeBinDir}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
}

function systemctl(...args: string[]): void {
  execSync(`systemctl --user ${args.join(' ')}`, { stdio: 'inherit' });
}

function systemctlQuery(...args: string[]): string {
  try {
    return execSync(`systemctl --user ${args.join(' ')}`, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function isSystemdActive(): boolean {
  return systemctlQuery('is-active', SERVICE_NAME) === 'active';
}

function isSystemdEnabled(): boolean {
  return systemctlQuery('is-enabled', SERVICE_NAME) === 'enabled';
}

function install() {
  mkdirSync(SERVICE_DIR, { recursive: true });
  writeFileSync(SERVICE_FILE, generateServiceContent());
  logger.info(`服务文件已写入: ${SERVICE_FILE}`);

  systemctl('daemon-reload');
  systemctl('enable', SERVICE_NAME);
  logger.info('开机自启已启用');

  // enable-linger 让用户服务在未登录时也能运行
  try {
    execSync('loginctl enable-linger', { stdio: 'inherit' });
    logger.info('linger 已启用（服务可在未登录时运行）');
  } catch {
    logger.warn('enable-linger 失败，服务可能需要用户登录后才会启动');
  }

  systemctl('start', SERVICE_NAME);
  systemctl('status', SERVICE_NAME);
}

function uninstall() {
  try {
    systemctl('stop', SERVICE_NAME);
  } catch { /* 服务可能没在运行 */ }

  try {
    systemctl('disable', SERVICE_NAME);
  } catch { /* 服务可能没启用 */ }

  if (existsSync(SERVICE_FILE)) {
    unlinkSync(SERVICE_FILE);
    logger.info(`服务文件已删除: ${SERVICE_FILE}`);
  }

  systemctl('daemon-reload');
  logger.info('开机自启已卸载');
}

function status() {
  if (isSystemdActive()) {
    logger.info(`运行方式: systemd（开机自启: ${isSystemdEnabled() ? '已启用' : '未启用'}）`);
    systemctl('status', SERVICE_NAME, '--no-pager');
    return;
  }

  const pid = getPidFromFile();
  if (pid && isRunning(pid)) {
    let uptime = '';
    let mem = '';
    try {
      uptime = execSync(`ps -o etime= -p ${pid}`, { encoding: 'utf-8' }).trim();
      const rss = parseInt(execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf-8' }).trim(), 10);
      mem = `${(rss / 1024).toFixed(1)} MB`;
    } catch { /* ignore */ }
    logger.info('运行方式: 守护进程（cc-im -d）');
    logger.info(`PID: ${pid}`);
    if (uptime) logger.info(`运行时间: ${uptime}`);
    if (mem) logger.info(`内存占用: ${mem}`);
    return;
  }

  logger.info('服务未运行');
  if (isSystemdEnabled()) {
    logger.info('systemd 开机自启已启用，可用 cc-im install 重新启动');
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let command = 'start';
  let daemon = false;

  for (const arg of args) {
    if (arg === 'stop' || arg === 'install' || arg === 'uninstall' || arg === 'status') {
      command = arg;
    } else if (arg === '-d' || arg === '--daemon') {
      daemon = true;
    }
  }

  return { command, daemon };
}

function rotateDaemonLog(logPath: string) {
  try {
    const stats = statSync(logPath);
    if (stats.size > 10 * 1024 * 1024) { // 10MB
      const backupPath = logPath + '.1';
      if (existsSync(backupPath)) unlinkSync(backupPath);
      renameSync(logPath, backupPath);
      logger.info(`daemon.log 已轮转 (${(stats.size / 1024 / 1024).toFixed(1)}MB)`);
    }
  } catch {
    // 文件不存在或其他错误，忽略
  }
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
  rotateDaemonLog(outLog);
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
} else if (command === 'status') {
  status();
} else if (command === 'install') {
  install();
} else if (command === 'uninstall') {
  uninstall();
} else if (daemon) {
  startDaemon();
} else {
  await start();
}
