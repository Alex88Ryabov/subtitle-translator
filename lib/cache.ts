import { browser } from 'wxt/browser';
import type { TranslatedCue } from '@/lib/types';

const CACHE_PREFIX = 'cache:';
const CACHE_VERSION = 1;

interface CacheEntry {
  v: number;
  savedAt: number;
  cues: TranslatedCue[];
}

/** Простой стабильный хэш строки (djb2) — для ключей кэша. */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Прочитать переведённые cue из кэша. null — если нет или версия не совпала. */
export async function getCachedCues(key: string): Promise<TranslatedCue[] | null> {
  const fullKey = CACHE_PREFIX + key;
  const record = await browser.storage.local.get(fullKey);
  const entry = record[fullKey] as CacheEntry | undefined;
  if (!entry || entry.v !== CACHE_VERSION || !Array.isArray(entry.cues)) return null;
  return entry.cues;
}

/** Сохранить переведённые cue (перевод лекции делается один раз). */
export async function setCachedCues(key: string, cues: TranslatedCue[]): Promise<void> {
  const entry: CacheEntry = { v: CACHE_VERSION, savedAt: Date.now(), cues };
  await browser.storage.local.set({ [CACHE_PREFIX + key]: entry });
}
