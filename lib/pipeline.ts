import type { Cue, TargetLang, TranslatedCue } from '@/lib/types';
import type { TranslationProvider } from '@/lib/providers/types';
import { mergeCuesIntoSentences, splitTranslationsAcrossCues } from '@/lib/sentences';

/**
 * Полный конвейер перевода субтитров:
 * 1) склеить фрагментированные cue в предложения (авто-субтитры рвут фразы посреди предложения);
 * 2) перевести предложения батчем;
 * 3) распределить перевод обратно по cue пропорционально длине оригинала.
 *
 * Используется и в background (google-free), и в content script (chrome-local).
 */
export async function translateCues(
  cues: Cue[],
  targetLang: TargetLang,
  provider: TranslationProvider,
): Promise<TranslatedCue[]> {
  if (cues.length === 0) return [];
  const sentences = mergeCuesIntoSentences(cues);
  const translations = await provider.translateBatch(
    sentences.map((s) => s.text),
    targetLang,
  );
  if (translations.length !== sentences.length) {
    throw new Error(
      `Provider ${provider.id} вернул ${translations.length} переводов вместо ${sentences.length}`,
    );
  }
  return splitTranslationsAcrossCues(cues, sentences, translations);
}
