import type { TargetLang } from '@/lib/types';
import type { TranslationProvider } from '@/lib/providers/types';

/**
 * Минимальные ambient-типы экспериментального Translator API (Chrome 138+).
 * API доступен только в window-контекстах (content script), не в service worker.
 */
interface LocalTranslator {
  translate(text: string): Promise<string>;
}

type TranslatorAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface TranslatorStatic {
  availability(opts: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<TranslatorAvailability>;
  create(opts: { sourceLanguage: string; targetLanguage: string }): Promise<LocalTranslator>;
}

declare global {
  // eslint-disable-next-line no-var
  var Translator: TranslatorStatic | undefined;
}

/** Кэш созданных переводчиков по целевому языку (создание может качать модель). */
const translators = new Map<TargetLang, LocalTranslator>();

async function getTranslator(targetLang: TargetLang): Promise<LocalTranslator> {
  const cached = translators.get(targetLang);
  if (cached) return cached;

  if (!('Translator' in globalThis) || !globalThis.Translator) {
    throw new Error('Локальный переводчик недоступен (нужен Chrome 138+)');
  }
  const api = globalThis.Translator;
  const opts = { sourceLanguage: 'en', targetLanguage: targetLang };

  const availability = await api.availability(opts);
  if (availability === 'unavailable') {
    throw new Error(`Локальный переводчик не поддерживает пару en → ${targetLang}`);
  }

  let translator: LocalTranslator;
  if (availability === 'downloadable' || availability === 'downloading') {
    // Модель ещё не скачана — пробуем create(), это может запустить загрузку.
    try {
      translator = await api.create(opts);
    } catch (e) {
      throw new Error(
        `Модель локального переводчика требует загрузки (может требовать действия пользователя): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  } else {
    translator = await api.create(opts);
  }

  translators.set(targetLang, translator);
  return translator;
}

/**
 * Встроенный переводчик Chrome (on-device). Работает только в content script.
 */
export const chromeLocalProvider: TranslationProvider = {
  id: 'chrome-local',

  async translateBatch(texts: string[], targetLang: TargetLang): Promise<string[]> {
    if (!('Translator' in globalThis)) {
      throw new Error('Локальный переводчик недоступен (нужен Chrome 138+)');
    }
    const translator = await getTranslator(targetLang);

    // Локальный инференс — переводим последовательно.
    const out: string[] = [];
    for (const text of texts) {
      if (text.trim() === '') {
        out.push('');
        continue;
      }
      out.push(await translator.translate(text));
    }
    return out;
  },
};
