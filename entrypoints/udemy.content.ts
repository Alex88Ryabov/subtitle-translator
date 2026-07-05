import { defineContentScript } from 'wxt/utils/define-content-script';
import { settingsItem } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Settings, type TranslatedCue } from '@/lib/types';
import { SubtitleOverlay } from '@/lib/overlay';
import { parseVtt } from '@/lib/vtt';
import { requestText, requestTranslation } from '@/lib/messaging';
import { getCachedCues, setCachedCues, hashString } from '@/lib/cache';
import { translateCues } from '@/lib/pipeline';
import { chromeLocalProvider } from '@/lib/providers/chrome-local';

const TAG = '[course-translator]';
const SYNC_INTERVAL_MS = 250;
const VIDEO_POLL_MS = 500;
const FALLBACK_DEBOUNCE_MS = 150;
const HIDE_STYLE_ID = 'course-translator-hide-native-captions';

/** Элемент data.asset.captions[] из api-2.0. Поля могут отсутствовать. */
interface Caption {
  locale_id?: string;
  video_label?: string;
  url?: string;
  source?: string;
}

/** lectureId из URL вида /course/{slug}/learn/lecture/{id}. null — не страница лекции. */
function getLectureId(url: string = location.href): string | null {
  const m = /\/learn\/lecture\/(\d+)/.exec(url);
  return m ? m[1]! : null;
}

/** courseId из data-module-args лоадера Udemy (JSON с courseId). */
function resolveCourseId(): string | null {
  try {
    const el = document.querySelector<HTMLElement>('.ud-app-loader');
    const raw = el?.dataset['moduleArgs'];
    if (!raw) return null;
    const args = JSON.parse(raw) as { courseId?: number | string };
    return args.courseId != null ? String(args.courseId) : null;
  } catch (e) {
    console.warn(`${TAG} failed to parse module args`, e);
    return null;
  }
}

/**
 * Метаданные субтитров лекции через приватный api-2.0 (работает с куками
 * залогиненного пользователя). null — нет доступа/нет субтитров (не фатально:
 * остаётся DOM-fallback).
 */
async function fetchCaptions(courseId: string, lectureId: string): Promise<Caption[] | null> {
  try {
    const url =
      `${location.origin}/api-2.0/users/me/subscribed-courses/${courseId}` +
      `/lectures/${lectureId}/?fields[lecture]=asset&fields[asset]=captions`;
    const res = await fetch(url, {
      credentials: 'include',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    if (!res.ok) {
      console.warn(`${TAG} captions API returned ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      asset?: { captions?: Caption[] };
      data?: { asset?: { captions?: Caption[] } };
    };
    const captions = json.asset?.captions ?? json.data?.asset?.captions;
    return Array.isArray(captions) ? captions : null;
  } catch (e) {
    console.warn(`${TAG} captions API failed`, e);
    return null;
  }
}

/** Выбрать английский трек; ручной приоритетнее автогенерированного ('[Auto]'). */
function pickCaption(captions: Caption[]): Caption | null {
  const withUrl = captions.filter((c) => c.url);
  const en = withUrl.filter((c) => /^en/i.test(c.locale_id ?? ''));
  const manual = en.find((c) => !/auto/i.test(c.video_label ?? ''));
  return manual ?? en[0] ?? withUrl[0] ?? null;
}

/**
 * Скачать VTT: сперва напрямую из content script; если CDN не отдал CORS —
 * через background (host_permissions снимают ограничение).
 */
async function fetchVtt(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal });
    if (res.ok) return await res.text();
    console.warn(`${TAG} direct VTT fetch returned ${res.status}, trying background`);
  } catch (e) {
    if (signal.aborted) throw e;
    console.log(`${TAG} direct VTT fetch blocked (likely CORS), trying background`);
  }
  const resp = await requestText(url);
  if (!resp.ok || resp.text === undefined) {
    console.warn(`${TAG} background VTT fetch failed: ${resp.error}`);
    return null;
  }
  return resp.text;
}

/** Бинарный поиск активного cue (cues отсортированы по start). -1 — нет активного. */
function findActiveCueIndex(cues: TranslatedCue[], t: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid]!;
    if (t < c.start) hi = mid - 1;
    else if (t > c.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Скрыть/показать нативные субтитры Udemy (иначе дублируются с нашим оверлеем).
 * CSS-правило вместо правок React-управляемого DOM: плеер пересоздаёт узлы.
 */
function setNativeCaptionsHidden(hidden: boolean): void {
  const existing = document.getElementById(HIDE_STYLE_ID);
  if (hidden) {
    if (existing) return;
    const style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    // data-purpose="captions-cue-text" — стабильный атрибут текста субтитра;
    // контейнер матчим по префиксу класса (хэш-суффиксы ротируются при деплоях).
    // visibility (не display): DOM продолжает обновляться — fallback-режим его читает.
    style.textContent =
      '[data-purpose="captions-cue-text"], [class*="captions-display--captions-container"]' +
      ' { visibility: hidden !important; }';
    document.head.appendChild(style);
  } else {
    existing?.remove();
  }
}

export default defineContentScript({
  matches: ['*://*.udemy.com/*'],

  async main(ctx) {
    // ---------- состояние ----------
    let settings: Settings;
    try {
      settings = await settingsItem.getValue();
    } catch (e) {
      console.warn(`${TAG} failed to read settings, using defaults`, e);
      settings = { ...DEFAULT_SETTINGS };
    }

    const overlay = new SubtitleOverlay();
    let video: HTMLVideoElement | null = null;
    let cues: TranslatedCue[] | null = null;
    let activeCueIndex = -1;
    let currentLectureId: string | null = null;

    let generation = 0;
    let currentAbort: AbortController | null = null;

    let syncInterval: number | null = null;
    let videoPoll: number | null = null;
    let fallbackObserver: MutationObserver | null = null;
    let fallbackTimer: number | null = null;
    let lastFallbackText = '';

    let destroyed = false;
    const cleanups: Array<() => void> = [];

    function teardown(): void {
      if (destroyed) return;
      destroyed = true;
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    }
    ctx.onInvalidated(teardown);

    cleanups.push(() => {
      currentAbort?.abort();
      if (syncInterval !== null) clearInterval(syncInterval);
      if (videoPoll !== null) clearInterval(videoPoll);
      stopDomFallback();
      unbindVideo();
      setNativeCaptionsHidden(false);
      overlay.destroy();
    });

    // ---------- синхронизация по треку ----------
    function tick(): void {
      try {
        if (!settings.enabled || !cues || !video) return;
        const idx = findActiveCueIndex(cues, video.currentTime);
        if (idx === activeCueIndex) return;
        activeCueIndex = idx;
        if (idx === -1) {
          overlay.update('', '');
        } else {
          const c = cues[idx]!;
          overlay.update(c.text, c.translation);
        }
      } catch (e) {
        console.warn(`${TAG} sync tick failed`, e);
      }
    }

    // ---------- привязка к <video> (SPA пересоздаёт элемент между лекциями) ----------
    function unbindVideo(): void {
      if (!video) return;
      video.removeEventListener('timeupdate', tick);
      video = null;
    }

    function bindVideo(v: HTMLVideoElement): void {
      if (video !== v) {
        unbindVideo();
        video = v;
        v.addEventListener('timeupdate', tick);
      }
      // Оверлей — в контейнер плеера (родитель <video>), чтобы жил в fullscreen.
      // Перемонтируем и когда React пересоздал контейнер вокруг того же <video>.
      const container = v.parentElement;
      if (container && !overlay.isMountedIn(container)) {
        overlay.destroy();
        overlay.mount(container);
        overlay.applySettings(settings);
        overlay.setVisible(settings.enabled);
      }
    }

    /**
     * <video> плеера лекции. querySelector со списком селекторов вернул бы
     * ПЕРВЫЙ в порядке документа, а не по приоритету — поэтому ищем по очереди.
     */
    function findPlayerVideo(): HTMLVideoElement | null {
      return (
        document.querySelector<HTMLVideoElement>(
          '[data-purpose="curriculum-item-viewer-content"] video',
        ) ??
        document.querySelector<HTMLVideoElement>('video.vjs-tech') ??
        document.querySelector<HTMLVideoElement>('video')
      );
    }

    /** Дождаться появления <video> текущей лекции (плеер грузится лениво). */
    function waitForVideo(signal: AbortSignal): Promise<HTMLVideoElement> {
      return new Promise((resolve, reject) => {
        const tryFind = (): boolean => {
          const v = findPlayerVideo();
          if (v) {
            resolve(v);
            return true;
          }
          return false;
        };
        if (tryFind()) return;
        const iv = window.setInterval(() => {
          if (signal.aborted) {
            clearInterval(iv);
            reject(new DOMException('aborted', 'AbortError'));
            return;
          }
          if (tryFind()) clearInterval(iv);
        }, VIDEO_POLL_MS);
      });
    }

    // ---------- fallback: наблюдение за DOM нативных субтитров ----------
    // Когда api-2.0 недоступен (нет подписки/эндпоинт изменился), переводим
    // построчно текст из [data-purpose="captions-cue-text"]. Качество ниже
    // (нет склейки предложений), зато не зависит от приватного API.
    function startDomFallback(): void {
      stopDomFallback();
      console.log(`${TAG} udemy: DOM fallback mode`);
      overlay.showStatus('Режим построчного перевода: включите англ. субтитры (CC) в плеере');
      // Нативные субтитры прячем и здесь: visibility:hidden не мешает
      // MutationObserver читать их текст, а дублирования на экране нет.
      setNativeCaptionsHidden(true);

      const handle = (): void => {
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        fallbackTimer = window.setTimeout(() => {
          fallbackTimer = null;
          void translateFallbackLine();
        }, FALLBACK_DEBOUNCE_MS);
      };

      fallbackObserver = new MutationObserver(handle);
      fallbackObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    function stopDomFallback(): void {
      fallbackObserver?.disconnect();
      fallbackObserver = null;
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      lastFallbackText = '';
    }

    async function translateFallbackLine(): Promise<void> {
      try {
        if (!settings.enabled || destroyed) return;
        const el = document.querySelector('[data-purpose="captions-cue-text"]');
        const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text === '' || text === lastFallbackText) return;
        lastFallbackText = text;

        const keyFor = (engine: string): string =>
          `udemy-live:${settings.targetLang}:${engine}:${hashString(text)}`;

        // Уважаем выбранный движок: chrome-local переводит локально,
        // без отправки текста в Google (пользователь мог выбрать его осознанно).
        let translation: string | null = null;
        if (settings.engine === 'chrome-local') {
          const cached = await getCachedCues(keyFor('chrome-local'));
          if (cached?.[0]) {
            translation = cached[0].translation;
          } else {
            try {
              const local = await translateCues(
                [{ start: 0, end: 1, text }],
                settings.targetLang,
                chromeLocalProvider,
              );
              translation = local[0]?.translation ?? null;
              if (local[0]) await setCachedCues(keyFor('chrome-local'), local);
            } catch (e) {
              console.warn(`${TAG} chrome-local fallback line failed, using google`, e);
            }
          }
        }
        if (translation === null) {
          const key = keyFor('google-free');
          const cached = await getCachedCues(key);
          if (cached?.[0]) {
            translation = cached[0].translation;
          } else {
            const resp = await requestTranslation({
              cacheKey: key,
              cues: [{ start: 0, end: 1, text }],
              targetLang: settings.targetLang,
              engine: 'google-free',
            });
            translation = resp.ok ? (resp.cues?.[0]?.translation ?? null) : null;
          }
        }
        // Пока переводили, текст мог смениться — не перетираем более новый.
        if (translation !== null && lastFallbackText === text) {
          overlay.update(text, translation);
        }
      } catch (e) {
        console.warn(`${TAG} fallback line translation failed`, e);
      }
    }

    // ---------- настройка текущей лекции ----------
    async function setupLecture(): Promise<void> {
      currentAbort?.abort();
      const abort = new AbortController();
      currentAbort = abort;
      const gen = ++generation;
      const alive = (): boolean =>
        !destroyed && gen === generation && !abort.signal.aborted && settings.enabled;

      cues = null;
      activeCueIndex = -1;
      stopDomFallback();
      overlay.update('', '');
      setNativeCaptionsHidden(false);
      if (!settings.enabled) return;

      const lectureId = getLectureId();
      currentLectureId = lectureId;
      if (!lectureId) return; // не страница лекции — ждём навигации

      try {
        const v = await waitForVideo(abort.signal);
        if (!alive()) return;
        bindVideo(v);

        overlay.showStatus('Перевожу субтитры…', false, true);

        const courseId = resolveCourseId();
        const captions = courseId ? await fetchCaptions(courseId, lectureId) : null;
        if (!alive()) return;

        const caption = captions ? pickCaption(captions) : null;
        if (!caption?.url) {
          // Нет доступа к API или нет треков — построчный режим по DOM.
          startDomFallback();
          return;
        }

        const vttText = await fetchVtt(caption.url, abort.signal);
        if (!alive()) return;
        if (vttText === null) {
          startDomFallback();
          return;
        }

        const rawCues = parseVtt(vttText);
        if (rawCues.length === 0) {
          overlay.showStatus('Файл субтитров пуст — переводить нечего');
          return;
        }

        // Ключ не включает подписанные query-параметры URL (они меняются) —
        // хэшируем только путь файла.
        const vttPath = caption.url.split('?')[0]!;
        const keyFor = (engine: string): string =>
          `udemy:${courseId}:${lectureId}:${settings.targetLang}:${engine}:${hashString(vttPath)}`;

        let translated: TranslatedCue[];
        if (settings.engine === 'chrome-local') {
          try {
            const cached = await getCachedCues(keyFor('chrome-local'));
            if (cached) {
              translated = cached;
            } else {
              translated = await translateCues(rawCues, settings.targetLang, chromeLocalProvider);
              await setCachedCues(keyFor('chrome-local'), translated);
            }
          } catch (e) {
            console.warn(`${TAG} chrome-local failed, falling back to google-free`, e);
            if (!alive()) return;
            overlay.showStatus('Локальный переводчик недоступен — использую Google', false, true);
            const resp = await requestTranslation({
              cacheKey: keyFor('google-free'),
              cues: rawCues,
              targetLang: settings.targetLang,
              engine: 'google-free',
            });
            if (!resp.ok || !resp.cues) throw new Error(resp.error ?? 'translation failed');
            translated = resp.cues;
          }
        } else {
          const resp = await requestTranslation({
            cacheKey: keyFor(settings.engine),
            cues: rawCues,
            targetLang: settings.targetLang,
            engine: settings.engine,
          });
          if (!resp.ok || !resp.cues) throw new Error(resp.error ?? 'translation failed');
          translated = resp.cues;
        }

        if (!alive()) return;
        translated = [...translated].sort((a, b) => a.start - b.start);
        cues = translated;
        activeCueIndex = -1;
        overlay.hideStatus();
        setNativeCaptionsHidden(true);
        console.log(`${TAG} udemy lecture ${lectureId}: ${translated.length} cues ready`);
        tick();
      } catch (e) {
        if (abort.signal.aborted || destroyed) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`${TAG} lecture setup failed:`, e);
        overlay.showStatus(`Ошибка перевода: ${msg}`, true);
      }
    }

    // ---------- SPA-навигация между лекциями ----------
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      const id = getLectureId();
      if (id !== currentLectureId) {
        console.log(`${TAG} udemy: lecture changed → ${id}`);
        void setupLecture();
      }
    });

    // Плеер может пересоздать <video> или контейнер без смены URL (смена
    // качества, ре-рендер React). Работает и в fallback-режиме (cues === null),
    // иначе оверлей осиротеет в удалённом поддереве.
    videoPoll = window.setInterval(() => {
      if (destroyed || !settings.enabled) return;
      const v = findPlayerVideo();
      if (v) bindVideo(v); // bindVideo сам решает, нужно ли перемонтирование
    }, 2000);

    syncInterval = window.setInterval(tick, SYNC_INTERVAL_MS);

    // ---------- живое применение настроек ----------
    const unwatch = settingsItem.watch((next) => {
      if (!next) return;
      const prev = settings;
      settings = next;
      overlay.applySettings(next);
      overlay.setVisible(next.enabled);
      if (!next.enabled) {
        setNativeCaptionsHidden(false);
        stopDomFallback();
        overlay.update('', '');
        return;
      }
      if (
        prev.enabled !== next.enabled ||
        prev.engine !== next.engine ||
        prev.targetLang !== next.targetLang
      ) {
        void setupLecture();
      }
    });
    cleanups.push(unwatch);

    // ---------- старт ----------
    console.log(`${TAG} udemy content script loaded`);
    void setupLecture();
  },
});
