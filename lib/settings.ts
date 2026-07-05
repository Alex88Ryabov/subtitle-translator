import { storage } from '@wxt-dev/storage';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';

/** Единственный источник правды для настроек. Доступен из popup, background и content scripts. */
export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});
