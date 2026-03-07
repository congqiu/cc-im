import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { APP_HOME } from '../constants.js';
import { createLogger } from '../logger.js';

const log = createLogger('ActiveChats');

const ACTIVE_CHATS_FILE = join(APP_HOME, 'data', 'active-chats.json');
const SAVE_DEBOUNCE_MS = 500;

interface ActiveChatsData {
  feishu?: string;
  telegram?: string;
}

let data: ActiveChatsData = {};
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const dir = dirname(ACTIVE_CHATS_FILE);
      await mkdir(dir, { recursive: true });
      await writeFile(ACTIVE_CHATS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      log.warn('Failed to save active chats:', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

export function loadActiveChats(): void {
  try {
    if (existsSync(ACTIVE_CHATS_FILE)) {
      data = JSON.parse(readFileSync(ACTIVE_CHATS_FILE, 'utf-8'));
    }
  } catch {
    data = {};
  }
}

export function getActiveChatId(platform: 'feishu' | 'telegram'): string | undefined {
  return data[platform];
}

export function setActiveChatId(platform: 'feishu' | 'telegram', chatId: string): void {
  if (data[platform] === chatId) return;
  data[platform] = chatId;
  scheduleSave();
}

export function flushActiveChats(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const dir = dirname(ACTIVE_CHATS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(ACTIVE_CHATS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    log.warn('Failed to flush active chats:', err);
  }
}
