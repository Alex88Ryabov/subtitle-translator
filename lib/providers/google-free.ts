import type { TargetLang } from '@/lib/types';
import type { TranslationProvider } from '@/lib/providers/types';

/** Лимиты одного запроса к неофициальному endpoint'у Google Translate. */
const MAX_CHUNK_CHARS = 4000;
const MAX_CHUNK_LINES = 100;
const DELAY_BETWEEN_CHUNKS_MS = 200;
const DELAY_BETWEEN_FALLBACK_MS = 150;
/** Backoff при 429/5xx: 1 с, затем 3 с. */
const RETRY_DELAYS_MS = [1000, 3000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ответ endpoint'а: data[0] — массив сегментов, segment[0] — фрагмент перевода. */
type GtxResponse = [Array<[string, ...unknown[]]>, ...unknown[]];

/**
 * Один HTTP-запрос перевода. Возвращает склеенный перевод (переводы строк '\n'
 * обычно сохраняются). Ретраи на 429/5xx с backoff.
 */
async function fetchTranslation(text: string, targetLang: TargetLang): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single' +
    `?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;

  let lastStatus = 0;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as GtxResponse;
      const segments = data?.[0];
      if (!Array.isArray(segments)) {
        throw new Error('[course-translator] google-free: неожиданный формат ответа');
      }
      let out = '';
      for (const seg of segments) {
        if (typeof seg?.[0] === 'string') out += seg[0];
      }
      return out;
    }
    lastStatus = res.status;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  throw new Error(
    `Google Translate запрос не удался (HTTP ${lastStatus}). Попробуйте позже.`,
  );
}

/** Разбить тексты на чанки: суммарно <= 4000 символов ('\n'-joined) и <= 100 строк. */
function chunkTexts(texts: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0; // длина '\n'-joined payload
  for (const t of texts) {
    const addedLen = current.length === 0 ? t.length : t.length + 1;
    if (current.length > 0 && (currentLen + addedLen > MAX_CHUNK_CHARS || current.length >= MAX_CHUNK_LINES)) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(t);
    currentLen += current.length === 1 ? t.length : t.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Fallback: перевести каждый текст чанка отдельным запросом (последовательно). */
async function translateIndividually(texts: string[], targetLang: TargetLang): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (i > 0) await sleep(DELAY_BETWEEN_FALLBACK_MS);
    out.push((await fetchTranslation(texts[i], targetLang)).trim());
  }
  return out;
}

/**
 * Бесплатный неофициальный Google Translate (endpoint client=gtx).
 * Работает в background service worker (host_permissions включает translate.googleapis.com).
 */
export const googleFreeProvider: TranslationProvider = {
  id: 'google-free',

  async translateBatch(texts: string[], targetLang: TargetLang): Promise<string[]> {
    // Пустые строки не отправляем — вернём их как '' на исходных позициях.
    const nonEmptyIdx: number[] = [];
    const nonEmpty: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (texts[i].trim() !== '') {
        nonEmptyIdx.push(i);
        nonEmpty.push(texts[i]);
      }
    }

    const result: string[] = texts.map(() => '');
    if (nonEmpty.length === 0) return result;

    const chunks = chunkTexts(nonEmpty);
    const translated: string[] = [];
    for (let c = 0; c < chunks.length; c++) {
      if (c > 0) await sleep(DELAY_BETWEEN_CHUNKS_MS);
      const chunk = chunks[c];
      const joined = chunk.join('\n');
      const raw = await fetchTranslation(joined, targetLang);
      const lines = raw.split('\n').map((l) => l.trim());
      if (lines.length === chunk.length) {
        translated.push(...lines);
      } else {
        // Google склеил/разорвал строки — переводим этот чанк по одному тексту.
        console.warn(
          `[course-translator] google-free: чанк вернул ${lines.length} строк вместо ${chunk.length}, перевожу по одной`,
        );
        translated.push(...(await translateIndividually(chunk, targetLang)));
      }
    }

    for (let i = 0; i < nonEmptyIdx.length; i++) {
      result[nonEmptyIdx[i]] = translated[i];
    }
    return result;
  },
};
