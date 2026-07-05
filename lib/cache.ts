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

/**
 * Сохранить переведённые cue (перевод лекции делается один раз).
 * НИКОГДА не бросает: сбой записи в кэш не должен превращать успешный перевод
 * в ошибку для пользователя. При переполнении квоты storage.local (10 МБ)
 * вытесняет самые старые записи и повторяет запись один раз.
 */
export async function setCachedCues(key: string, cues: TranslatedCue[]): Promise<void> {
  const entry: CacheEntry = { v: CACHE_VERSION, savedAt: Date.now(), cues };
  const record = { [CACHE_PREFIX + key]: entry };
  try {
    await browser.storage.local.set(record);
  } catch (e) {
    console.warn('[course-translator] cache write failed, evicting oldest entries', e);
    try {
      await evictOldestEntries(EVICT_COUNT);
      await browser.storage.local.set(record);
    } catch (e2) {
      console.warn('[course-translator] cache write failed after eviction, giving up', e2);
    }
  }
}

/** Сколько самых старых записей удалять при переполнении. */
const EVICT_COUNT = 20;

/** Удалить count самых старых записей кэша (LRU по savedAt). */
async function evictOldestEntries(count: number): Promise<void> {
  const all = await browser.storage.local.get(null);
  const cacheKeys = Object.keys(all)
    .filter((k) => k.startsWith(CACHE_PREFIX))
    .sort((a, b) => {
      const ea = all[a] as CacheEntry | undefined;
      const eb = all[b] as CacheEntry | undefined;
      return (ea?.savedAt ?? 0) - (eb?.savedAt ?? 0);
    });
  const toRemove = cacheKeys.slice(0, count);
  if (toRemove.length > 0) await browser.storage.local.remove(toRemove);
}
