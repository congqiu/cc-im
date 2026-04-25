import { get } from 'node:https';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createLogger } from '../logger.js';
import { APP_HOME } from '../constants.js';

const log = createLogger('UpdateCheck');

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/cc-im/latest';
const FETCH_TIMEOUT_MS = 5000;

const CACHE_FILE = join(APP_HOME, 'data', 'update-check-cache.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

interface UpdateCache {
  version: string;
  timestamp: number;
}

function readCache(): UpdateCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    if (typeof data.version === 'string' && typeof data.timestamp === 'number') {
      return data;
    }
  } catch { /* ignore */ }
  return null;
}

function writeCache(version: string) {
  try {
    const dir = dirname(CACHE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ version, timestamp: Date.now() }));
  } catch { /* ignore */ }
}

function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = get(NPM_REGISTRY_URL, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try {
          const { version } = JSON.parse(data);
          resolve(typeof version === 'string' ? version : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * 比较语义化版本，返回 true 表示 latest 比 current 更新
 */
function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const c = parse(current);
  const l = parse(latest);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

/**
 * 异步检查是否有新版本，有则打印提示日志。不阻塞启动流程。
 * 使用本地文件缓存（24 小时 TTL），避免频繁启动时重复请求 npm。
 */
export async function checkForUpdate(currentVersion: string): Promise<void> {
  try {
    // 检查缓存
    const cache = readCache();
    if (cache && Date.now() - cache.timestamp < CACHE_TTL_MS) {
      if (isNewer(currentVersion, cache.version)) {
        log.info(`发现新版本 v${cache.version}（当前 v${currentVersion}），请运行: npx cc-im@latest 或 npm i -g cc-im@latest`);
      }
      return;
    }

    const latest = await fetchLatestVersion();
    if (latest) {
      writeCache(latest);
      if (isNewer(currentVersion, latest)) {
        log.info(`发现新版本 v${latest}（当前 v${currentVersion}），请运行: npx cc-im@latest 或 npm i -g cc-im@latest`);
      }
    }
  } catch {
    // 静默忽略，不影响正常启动
  }
}
