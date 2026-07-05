import type { Cue, Sentence, TranslatedCue } from '@/lib/types';

/**
 * Авто-субтитры рвут предложения посреди фразы. Для качества перевода
 * склеиваем последовательные cue в предложения, переводим целиком,
 * затем распределяем перевод обратно по cue пропорционально длине оригинала.
 */

/** Текст заканчивается терминальной пунктуацией (с учётом закрывающих кавычек/скобок). */
const TERMINAL_PUNCT_RE = /[.!?…]["'»")\]]*$/;

/** Максимальная пауза между cue внутри одного предложения, сек. */
const MAX_GAP_SEC = 3.0;
/** Максимум cue в одном предложении. */
const MAX_CUES_PER_SENTENCE = 8;
/** Максимальная длина склеенного текста предложения, символов. */
const MAX_SENTENCE_CHARS = 400;

/** Жадно склеить последовательные cue в предложения. */
export function mergeCuesIntoSentences(cues: Cue[]): Sentence[] {
  const sentences: Sentence[] = [];
  let indexes: number[] = [];
  let parts: string[] = [];

  const flush = () => {
    if (indexes.length === 0) return;
    sentences.push({ text: parts.join(' '), cueIndexes: indexes });
    indexes = [];
    parts = [];
  };

  for (let i = 0; i < cues.length; i++) {
    indexes.push(i);
    parts.push(cues[i].text);

    const joinedLen = parts.join(' ').length;
    const next = cues[i + 1];
    const boundary =
      TERMINAL_PUNCT_RE.test(cues[i].text) ||
      (next !== undefined && next.start - cues[i].end > MAX_GAP_SEC) ||
      indexes.length >= MAX_CUES_PER_SENTENCE ||
      joinedLen > MAX_SENTENCE_CHARS;

    if (boundary) flush();
  }
  flush(); // хвост без терминальной пунктуации

  return sentences;
}

/**
 * Распределить переводы предложений обратно по cue.
 * translations[i] — перевод sentences[i]. Слова перевода делятся между cue
 * пропорционально длине ОРИГИНАЛЬНОГО текста каждого cue; слова не теряются
 * и не дублируются (конкатенация по cue воспроизводит перевод).
 */
export function splitTranslationsAcrossCues(
  cues: Cue[],
  sentences: Sentence[],
  translations: string[],
): TranslatedCue[] {
  // По умолчанию '' — на случай cue, не покрытых ни одним предложением.
  const result: TranslatedCue[] = cues.map((c) => ({ ...c, translation: '' }));

  for (let s = 0; s < sentences.length; s++) {
    const idxs = sentences[s].cueIndexes;
    const translation = translations[s] ?? '';
    if (idxs.length === 0) continue;

    if (idxs.length === 1) {
      const idx = idxs[0];
      if (idx >= 0 && idx < result.length) result[idx].translation = translation;
      continue;
    }

    const words = translation.split(/\s+/).filter((w) => w !== '');
    const counts = allocateWordCounts(
      idxs.map((i) => (cues[i]?.text.length ?? 0)),
      words.length,
    );

    let cursor = 0;
    for (let j = 0; j < idxs.length; j++) {
      const idx = idxs[j];
      const chunk = words.slice(cursor, cursor + counts[j]);
      cursor += counts[j];
      if (idx >= 0 && idx < result.length) result[idx].translation = chunk.join(' ');
    }
  }

  return result;
}

/**
 * Распределить wordCount слов по k корзинам пропорционально lengths
 * (накопительная доля). Каждая корзина получает >= 1 слова, если слов хватает;
 * последняя забирает остаток. Сумма counts всегда равна wordCount.
 */
function allocateWordCounts(lengths: number[], wordCount: number): number[] {
  const k = lengths.length;
  const total = lengths.reduce((a, b) => a + b, 0);
  // Все длины нулевые — делим поровну.
  const weights = total > 0 ? lengths : lengths.map(() => 1);
  const weightSum = total > 0 ? total : k;

  const counts: number[] = [];
  let assigned = 0;
  let cum = 0;

  for (let j = 0; j < k; j++) {
    cum += weights[j];
    if (j === k - 1) {
      counts.push(wordCount - assigned); // последний забирает остаток
      break;
    }
    let n = Math.round((wordCount * cum) / weightSum) - assigned;
    const remainingBuckets = k - 1 - j;
    if (wordCount >= k) {
      // каждому >= 1 слова; оставить хотя бы по одному на оставшиеся корзины
      n = Math.max(1, Math.min(n, wordCount - assigned - remainingBuckets));
    } else {
      n = Math.max(0, Math.min(n, wordCount - assigned));
    }
    counts.push(n);
    assigned += n;
  }

  return counts;
}
