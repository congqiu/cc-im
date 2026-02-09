import { createWriteStream, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';

const LOG_DIR = 'logs';
const MAX_LOG_FILES = 10;

let logStream: WriteStream;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function getTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getLogFileName(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`;
}

function rotateOldLogs() {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ name: f, time: statSync(join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    for (let i = MAX_LOG_FILES; i < files.length; i++) {
      unlinkSync(join(LOG_DIR, files[i].name));
    }
  } catch {
    // ignore
  }
}

export function initLogger() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  rotateOldLogs();

  logStream = createWriteStream(join(LOG_DIR, getLogFileName()), { flags: 'a' });

  // Reopen log file at midnight
  const scheduleReopen = () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const ms = tomorrow.getTime() - now.getTime() + 1000;
    setTimeout(() => {
      logStream.end();
      rotateOldLogs();
      logStream = createWriteStream(join(LOG_DIR, getLogFileName()), { flags: 'a' });
      scheduleReopen();
    }, ms);
  };
  scheduleReopen();
}

function write(level: string, tag: string, msg: string, ...args: unknown[]) {
  const extra = args.length > 0
    ? ' ' + args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')
    : '';
  const line = `${getTimestamp()} [${level}] [${tag}] ${msg}${extra}\n`;

  if (level === 'ERROR') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }

  logStream?.write(line);
}

export function createLogger(tag: string) {
  return {
    info: (msg: string, ...args: unknown[]) => write('INFO', tag, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => write('WARN', tag, msg, ...args),
    error: (msg: string, ...args: unknown[]) => write('ERROR', tag, msg, ...args),
    debug: (msg: string, ...args: unknown[]) => write('DEBUG', tag, msg, ...args),
  };
}
