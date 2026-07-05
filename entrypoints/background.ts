import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import type {
  FetchTextRequest,
  FetchTextResponse,
  TranslateCuesRequest,
  TranslateCuesResponse,
} from '@/lib/messaging';
import { getCachedCues, setCachedCues } from '@/lib/cache';
import { translateCues } from '@/lib/pipeline';
import { googleFreeProvider } from '@/lib/providers/google-free';

/**
 * Обработка запроса на перевод. Без модульного мутабельного состояния —
 * MV3 worker умирает после ~30 с простоя, кэш живёт в storage.
 */
async function handleTranslateCues(req: TranslateCuesRequest): Promise<TranslateCuesResponse> {
  try {
    const cached = await getCachedCues(req.cacheKey);
    if (cached) {
      return { ok: true, cues: cached };
    }
    // Background всегда переводит через google-free: 'chrome-local' работает
    // в content script и сюда приходить не должен.
    if (req.engine !== 'google-free') {
      console.warn(
        `[course-translator] background получил engine '${req.engine}', использую google-free`,
      );
    }
    const cues = await translateCues(req.cues, req.targetLang, googleFreeProvider);
    await setCachedCues(req.cacheKey, cues);
    return { ok: true, cues };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[course-translator] ошибка перевода:', message);
    return { ok: false, error: message };
  }
}

/** Скачать текст по URL для content script (host_permissions обходят CORS). */
async function handleFetchText(req: FetchTextRequest): Promise<FetchTextResponse> {
  try {
    const res = await fetch(req.url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, text: await res.text() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default defineBackground(() => {
  console.log('[course-translator] background started');

  browser.runtime.onMessage.addListener(
    (msg: unknown, _sender, sendResponse: (res: unknown) => void) => {
      const type =
        typeof msg === 'object' && msg !== null ? (msg as { type?: unknown }).type : undefined;
      if (type === 'TRANSLATE_CUES') {
        void handleTranslateCues(msg as TranslateCuesRequest).then(sendResponse);
        return true; // держим канал открытым для асинхронного ответа
      }
      if (type === 'FETCH_TEXT') {
        void handleFetchText(msg as FetchTextRequest).then(sendResponse);
        return true;
      }
      return false;
    },
  );
});
