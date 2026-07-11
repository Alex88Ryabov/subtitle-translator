import { defineContentScript } from 'wxt/utils/define-content-script';
import { settingsItem } from '@/lib/settings';
import {
  DEFAULT_SETTINGS,
  type Cue,
  type Settings,
  type TargetLang,
  type TranslatedCue,
} from '@/lib/types';
import { SubtitleOverlay } from '@/lib/overlay';
import { cleanCueText, parseVtt } from '@/lib/vtt';
import { requestText, requestTranslation } from '@/lib/messaging';
import { getCachedCues, setCachedCues, hashString } from '@/lib/cache';
import { translateCues } from '@/lib/pipeline';
import { chromeLocalProvider } from '@/lib/providers/chrome-local';

const TAG = '[course-translator]';
const SYNC_INTERVAL_MS = 250;
const VIDEO_POLL_MS = 500;
const FALLBACK_DEBOUNCE_MS = 150;
/** Сколько ждать появления <track>/textTracks после загрузки плеера. */
const TRACK_WAIT_MS = 8000;
const HIDE_STYLE_ID = 'course-translator-hide-native-captions';

/** Идентификатор лекции: slug курса + id элемента (item) из URL. */
interface LectureRef {
  courseSlug: string;
  itemId: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Разбор URL лекции. Основной формат: /learn/{courseSlug}/lecture/{itemId}/{slug}.
 * Публичный превью-формат: /lecture/{courseSlug}/{lecture-slug}-{itemId} —
 * itemId там не всегда извлекается надёжно, поэтому может быть null
 * (API-путь тогда пропускается, треки работают и так).
 */
function getLectureRef(url: string = location.href): LectureRef | null {
  const path = new URL(url).pathname;
  let m = /\/learn\/([^/]+)\/lecture\/([^/?#]+)/.exec(path);
  if (m) return { courseSlug: m[1]!, itemId: m[2]! };
  m = /^\/lecture\/([^/]+)\/([^/?#]+)/.exec(path);
  if (m) {
    const tail = /-([A-Za-z0-9]+)$/.exec(m[2]!);
    return { courseSlug: m[1]!, itemId: tail ? tail[1]! : null };
  }
  return null;
}

/** Ключ лекции для сравнения при SPA-навигации. null — не страница лекции. */
function getLectureKey(url: string = location.href): string | null {
  const ref = getLectureRef(url);
  return ref ? `${ref.courseSlug}/${ref.itemId ?? '?'}` : null;
}

/**
 * <video> плеера лекции (Video.js внутри React). Селекторы по убыванию
 * специфичности; querySelector со списком вернул бы первый в порядке документа.
 */
function findPlayerVideo(): HTMLVideoElement | null {
  return (
    document.querySelector<HTMLVideoElement>('#video-player-row video') ??
    document.querySelector<HTMLVideoElement>('video.vjs-tech') ??
    document.querySelector<HTMLVideoElement>('video')
  );
}

/**
 * Контейнер для оверлея: корень плеера (в fullscreen именно он становится
 * fullscreenElement, поэтому оверлей должен жить внутри него).
 */
function findOverlayContainer(v: HTMLVideoElement): HTMLElement | null {
  return (
    v.closest<HTMLElement>('.rc-VideoPlayer, .c-video-player, .video-js') ?? v.parentElement
  );
}

/**
 * Путь src <track> без query: подписанные параметры (expiry, hmac) ротируются,
 * а сам opaque-путь идентифицирует ассет субтитров.
 */
function trackSrcPath(el: HTMLTrackElement): string {
  return el.src.split('?')[0]!;
}

/** <track>-элементы с src, кроме исключённых (треки предыдущей лекции). */
function listTrackEls(
  v: HTMLVideoElement,
  excludeSrcPaths: ReadonlySet<string>,
): HTMLTrackElement[] {
  return Array.from(v.querySelectorAll('track')).filter(
    (t) => t.src && !excludeSrcPaths.has(trackSrcPath(t)),
  );
}

/** Английский <track> из списка (Coursera вешает по <track> на язык). */
function pickEnglishTrackEl(els: HTMLTrackElement[]): HTMLTrackElement | null {
  return els.find((t) => /^en/i.test(t.srclang) || /english/i.test(t.label)) ?? null;
}

/** Английский TextTrack (или любой subtitles/captions, как на Udemy). */
function pickEnglishTextTrack(v: HTMLVideoElement): TextTrack | null {
  const tracks = Array.from(v.textTracks ?? []);
  return (
    tracks.find((t) => /^en/i.test(t.language) || /english/i.test(t.label)) ??
    tracks.find((t) => t.kind === 'subtitles' || t.kind === 'captions') ??
    null
  );
}

/** Извлечь cue из загруженного TextTrack (очистка та же, что у parseVtt). */
function extractTextTrackCues(t: TextTrack): Cue[] {
  const cues: Cue[] = [];
  for (const raw of Array.from(t.cues ?? [])) {
    const c = raw as VTTCue;
    const text = cleanCueText(c.text ?? '');
    if (text !== '' && c.endTime > c.startTime) {
      cues.push({ start: c.startTime, end: c.endTime, text });
    }
  }
  return cues;
}

/**
 * Скачать VTT: subtitleAssetProxy-URL same-origin, обычно достаточно прямого
 * fetch; при неожиданном отказе пробуем через background (host_permissions).
 */
async function fetchVtt(url: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(url, { signal });
    if (res.ok) return await res.text();
    console.warn(`${TAG} direct VTT fetch returned ${res.status}, trying background`);
  } catch (e) {
    if (signal.aborted) throw e;
    console.log(`${TAG} direct VTT fetch failed, trying background`);
  }
  const resp = await requestText(url);
  if (!resp.ok || resp.text === undefined) {
    console.warn(`${TAG} background VTT fetch failed: ${resp.error}`);
    return null;
  }
  return resp.text;
}

/** Числовой courseId по slug через публичный same-origin endpoint. */
async function resolveCourseId(courseSlug: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(
      `${location.origin}/api/onDemandCourses.v1?q=slug&slug=${encodeURIComponent(courseSlug)}`,
      {
        signal,
        credentials: 'include',
        headers: {
          'x-requested-with': 'XMLHttpRequest',
          accept: 'application/json, text/plain, */*',
        },
      },
    );
    if (!res.ok) {
      console.warn(`${TAG} onDemandCourses.v1 returned ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { elements?: Array<{ id?: string }> };
    const id = json.elements?.[0]?.id;
    if (id) {
      console.log(`${TAG} courseId via slug lookup: ${id}`);
      return id;
    }
  } catch (e) {
    if (!signal.aborted) console.warn(`${TAG} slug lookup failed`, e);
  }
  return null;
}

/**
 * План Б: карта subtitlesVtt {lang: path} через onDemandLectureVideos.v1.
 * Только из content script — куки CAUTH идут same-origin; background их не шлёт.
 */
async function fetchApiVttUrl(
  courseId: string,
  itemId: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const url =
      `${location.origin}/api/onDemandLectureVideos.v1/${courseId}~${itemId}` +
      `?includes=video&fields=onDemandVideos.v1(sources,subtitles,subtitlesVtt)`;
    const res = await fetch(url, {
      signal,
      credentials: 'include',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        accept: 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) {
      console.warn(`${TAG} onDemandLectureVideos.v1 returned ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      linked?: { 'onDemandVideos.v1'?: Array<{ subtitlesVtt?: Record<string, string> }> };
    };
    const vttMap = json.linked?.['onDemandVideos.v1']?.[0]?.subtitlesVtt;
    if (!vttMap) return null;
    const langs = Object.keys(vttMap);
    const en = langs.find((l) => /^en/i.test(l)) ?? langs[0];
    if (!en) return null;
    const path = vttMap[en]!;
    console.log(`${TAG} subtitlesVtt via API: [${langs.join(', ')}], picked ${en}`);
    // Пути относительные (/api/subtitleAssetProxy.v1/...) — префиксуем origin.
    return /^https?:\/\//.test(path) ? path : location.origin + path;
  } catch (e) {
    if (!signal.aborted) console.warn(`${TAG} lecture videos API failed`, e);
    return null;
  }
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
 * Скрыть нативные субтитры Coursera. Рендер-путь зависит от конфигурации
 * Video.js: нативный (::cue; visibility там поддерживается не везде, поэтому
 * ещё и transparent) либо эмулированный (.vjs-text-track-display).
 */
function setNativeCaptionsHidden(hidden: boolean): void {
  const existing = document.getElementById(HIDE_STYLE_ID);
  if (hidden) {
    if (existing) return;
    const style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    style.textContent =
      'video::cue { visibility: hidden !important; color: transparent !important;' +
      ' background: transparent !important; text-shadow: none !important; }\n' +
      '.vjs-text-track-display, .vjs-text-track-cue { visibility: hidden !important; }';
    document.head.appendChild(style);
  } else {
    existing?.remove();
  }
}

/** Активная фраза интерактивного транскрипта (селекторы по убыванию надёжности). */
function findTranscriptActiveEl(): Element | null {
  return (
    document.querySelector('.rc-Transcript .rc-Phrase.active') ??
    document.querySelector('.rc-Phrase.active') ??
    document.querySelector('.rc-Transcript .active')
  );
}

export default defineContentScript({
  // Весь origin, не только /lecture/: SPA-роутинг требует, чтобы скрипт уже
  // был загружен до перехода пользователя на страницу лекции.
  matches: ['*://www.coursera.org/*'],

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
    let currentLectureKey: string | null = null;
    /**
     * Лекция, которой принадлежат треки привязанного <video>. Не то же, что
     * currentLectureKey: после pushState URL уже новый, а DOM ещё старый.
     * Обновляется только когда треки реально приняты (или прошёл полный
     * цикл ожидания) — иначе быстрая навигация A→B→A исключила бы треки самой A.
     */
    let videoLectureKey: string | null = null;
    /** Треки, которые мы перевели из 'showing' в 'hidden' (восстановим при выключении). */
    const suppressedTracks = new Set<TextTrack>();
    let suppressTracks = false;

    let generation = 0;
    let currentAbort: AbortController | null = null;

    let syncInterval: number | null = null;
    let videoPoll: number | null = null;
    let fallbackObserver: MutationObserver | null = null;
    let fallbackTimer: number | null = null;
    let fallbackHintTimer: number | null = null;
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
      restoreSuppressedTracks();
      unbindVideo();
      setNativeCaptionsHidden(false);
      overlay.destroy();
    });

    // ---------- подавление нативного рендера субтитров ----------
    // CSS (::cue / .vjs-text-track-display) может не покрыть все режимы
    // Video.js, поэтому дополнительно гасим mode='showing' → 'hidden'.
    // Вызывается из tick(): CC-меню плеера может вернуть 'showing' в любой момент.
    function suppressShowingTracks(): void {
      if (!video) return;
      for (const t of Array.from(video.textTracks ?? [])) {
        if (t.mode === 'showing') {
          t.mode = 'hidden';
          suppressedTracks.add(t);
        }
      }
    }

    function restoreSuppressedTracks(): void {
      for (const t of suppressedTracks) {
        try {
          if (t.mode === 'hidden') t.mode = 'showing';
        } catch {
          // ignore
        }
      }
      suppressedTracks.clear();
    }

    // ---------- синхронизация по треку ----------
    function tick(): void {
      try {
        if (!settings.enabled || !video) return;
        if (suppressTracks) suppressShowingTracks();
        if (!cues) return;
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
      const container = findOverlayContainer(v);
      if (container && !overlay.isMountedIn(container)) {
        overlay.destroy();
        overlay.mount(container);
        overlay.applySettings(settings);
        overlay.setVisible(settings.enabled);
      }
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

    /**
     * План А: субтитры из плеера. Один цикл ожидания (до TRACK_WAIT_MS) на оба
     * источника: сперва английский <track> (его VTT качаем сами — same-origin,
     * подписанный URL), затем cue из его TextTrack, затем «голые» textTracks.
     *
     * После pushState React меняет DOM асинхронно: в первые секунды в DOM ещё
     * плеер ПРЕДЫДУЩЕЙ лекции. Поэтому каждый круг заново ищем <video>
     * (элемент могли пересоздать) и игнорируем треки уходящей лекции
     * (excludeSrcPaths / outgoingVideo) — иначе покажем её субтитры.
     */
    async function acquireTrackCues(
      excludeSrcPaths: ReadonlySet<string>,
      outgoingVideo: HTMLVideoElement | null,
      signal: AbortSignal,
    ): Promise<Cue[] | null> {
      const deadline = Date.now() + TRACK_WAIT_MS;
      // «Голым» textTracks (ветка 3) доверяем только со второй половины окна:
      // даём React время убрать чужой <video> (плеер прошлой лекции, трейлер).
      const softDeadline = deadline - TRACK_WAIT_MS / 2;
      const fetchTried = new Set<string>();

      while (Date.now() < deadline && !signal.aborted) {
        const v = findPlayerVideo();
        if (v) {
          bindVideo(v); // bindVideo сам решает, нужно ли перепривязываться

          const els = listTrackEls(v, excludeSrcPaths);
          const el = pickEnglishTrackEl(els);

          // 1) Английский <track>: качаем его VTT напрямую.
          if (el && !fetchTried.has(trackSrcPath(el))) {
            fetchTried.add(trackSrcPath(el));
            const vtt = await fetchVtt(el.src, signal);
            if (signal.aborted) return null;
            if (vtt !== null) {
              const parsed = parseVtt(vtt);
              if (parsed.length > 0) {
                console.log(`${TAG} coursera: ${parsed.length} cues via <track> src (${el.srclang})`);
                return parsed;
              }
              console.warn(`${TAG} <track> VTT parsed to 0 cues`);
            }
          }

          // 2) VTT не скачался — cue из TextTrack того же элемента.
          if (el) {
            const tt = el.track;
            if (tt.mode === 'disabled') tt.mode = 'hidden';
            if (tt.cues && tt.cues.length > 0) {
              const extracted = extractTextTrackCues(tt);
              if (extracted.length > 0) {
                console.log(`${TAG} coursera: ${extracted.length} cues via track element`);
                return extracted;
              }
            }
          }

          // 3) <track>-элементов нет ВООБЩЕ (считаем без фильтра: элемент с
          // исключёнными треками — это плеер прошлой лекции, его textTracks
          // читать нельзя) — тогда, не раньше softDeadline и не у «уходящего»
          // <video>, доверяем чистым textTracks.
          const totalTrackEls = v.querySelectorAll('track').length;
          if (totalTrackEls === 0 && v !== outgoingVideo && Date.now() >= softDeadline) {
            const tt = pickEnglishTextTrack(v);
            if (tt) {
              if (tt.mode === 'disabled') tt.mode = 'hidden';
              if (tt.cues && tt.cues.length > 0) {
                const extracted = extractTextTrackCues(tt);
                if (extracted.length > 0) {
                  console.log(`${TAG} coursera: ${extracted.length} cues via textTracks (${tt.label})`);
                  return extracted;
                }
              }
            }
          }
        }
        await sleep(500);
      }
      if (signal.aborted) return null;

      // Дедлайн вышел: любой свежий <track> (не-английский — переводчики
      // заточены под en, но паритет с Udemy: лучше попытаться, чем ничего).
      const v = findPlayerVideo();
      const any = v ? listTrackEls(v, excludeSrcPaths)[0] : undefined;
      if (any && !fetchTried.has(trackSrcPath(any))) {
        const vtt = await fetchVtt(any.src, signal);
        if (signal.aborted) return null;
        if (vtt !== null) {
          const parsed = parseVtt(vtt);
          if (parsed.length > 0) {
            console.log(`${TAG} coursera: ${parsed.length} cues via non-en <track> (${any.srclang})`);
            return parsed;
          }
        }
      }
      console.log(`${TAG} coursera: no usable tracks`);
      return null;
    }

    // ---------- fallback: интерактивный транскрипт ----------
    // Нативный рендер cue живёт в UA shadow root и из JS нечитаем (в отличие
    // от Udemy), поэтому последний рубеж — панель Transcript под видео:
    // текущая фраза получает класс .active.
    function startDomFallback(): void {
      stopDomFallback();
      console.log(`${TAG} coursera: transcript fallback mode`);
      overlay.showStatus('Режим построчного перевода: откройте вкладку Transcript под видео');
      suppressTracks = true;
      setNativeCaptionsHidden(true);

      fallbackHintTimer = window.setTimeout(() => {
        if (destroyed || lastFallbackText !== '') return;
        const el = findTranscriptActiveEl();
        console.warn(
          `${TAG} fallback: transcript element ${el ? 'exists but no text yet' : 'NOT FOUND'}`,
        );
        overlay.showStatus(
          el
            ? 'Транскрипт пока пуст — запустите воспроизведение'
            : 'Не вижу транскрипт — откройте вкладку Transcript под видео',
          true,
        );
      }, 12000);

      const handle = (): void => {
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        fallbackTimer = window.setTimeout(() => {
          fallbackTimer = null;
          void translateFallbackLine();
        }, FALLBACK_DEBOUNCE_MS);
      };

      fallbackObserver = new MutationObserver(handle);
      // Смена активной фразы — это смена класса, поэтому attributes обязателен.
      fallbackObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
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
      if (fallbackHintTimer !== null) {
        clearTimeout(fallbackHintTimer);
        fallbackHintTimer = null;
      }
      lastFallbackText = '';
    }

    async function translateFallbackLine(): Promise<void> {
      try {
        if (!settings.enabled || destroyed) return;
        // Снимок на входе: смена лекции/настроек во время перевода не должна
        // дать устаревшему ответу перетереть более новый (или лечь под чужой ключ).
        const gen = generation;
        const lang = settings.targetLang;
        const engine = settings.engine;
        const el = findTranscriptActiveEl();
        const text = (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text === '' || text === lastFallbackText) return;
        lastFallbackText = text;

        const keyFor = (eng: string): string =>
          `coursera-live:${lang}:${eng}:${hashString(text)}`;

        // Уважаем выбранный движок: chrome-local переводит локально,
        // без отправки текста в Google (пользователь мог выбрать его осознанно).
        let translation: string | null = null;
        if (engine === 'chrome-local') {
          const cached = await getCachedCues(keyFor('chrome-local'));
          if (cached?.[0]) {
            translation = cached[0].translation;
          } else {
            try {
              const local = await translateCues(
                [{ start: 0, end: 1, text }],
                lang,
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
              targetLang: lang,
              engine: 'google-free',
            });
            translation = resp.ok ? (resp.cues?.[0]?.translation ?? null) : null;
          }
        }
        // Пока переводили, фраза или настройки могли смениться — не перетираем.
        if (
          translation !== null &&
          lastFallbackText === text &&
          gen === generation &&
          !destroyed
        ) {
          overlay.update(text, translation);
        }
      } catch (e) {
        console.warn(`${TAG} fallback line translation failed`, e);
      }
    }

    // ---------- перевод полного трека ----------
    async function activateTrack(
      rawCues: Cue[],
      keyFor: (engine: string) => string,
      lang: TargetLang,
      alive: () => boolean,
    ): Promise<void> {
      // Движок фиксируем на входе: смена настроек в середине перевода не должна
      // положить результат одного движка под ключ другого.
      const engine = settings.engine;
      let translated: TranslatedCue[];
      if (engine === 'chrome-local') {
        try {
          const cached = await getCachedCues(keyFor('chrome-local'));
          if (cached) {
            translated = cached;
          } else {
            translated = await translateCues(rawCues, lang, chromeLocalProvider);
            await setCachedCues(keyFor('chrome-local'), translated);
          }
        } catch (e) {
          console.warn(`${TAG} chrome-local failed, falling back to google-free`, e);
          if (!alive()) return;
          overlay.showStatus('Локальный переводчик недоступен — использую Google', false, true);
          const resp = await requestTranslation({
            cacheKey: keyFor('google-free'),
            cues: rawCues,
            targetLang: lang,
            engine: 'google-free',
          });
          if (!resp.ok || !resp.cues) throw new Error(resp.error ?? 'translation failed');
          translated = resp.cues;
        }
      } else {
        const resp = await requestTranslation({
          cacheKey: keyFor(engine),
          cues: rawCues,
          targetLang: lang,
          engine,
        });
        if (!resp.ok || !resp.cues) throw new Error(resp.error ?? 'translation failed');
        translated = resp.cues;
      }

      if (!alive()) return;
      translated = [...translated].sort((a, b) => a.start - b.start);
      cues = translated;
      activeCueIndex = -1;
      overlay.hideStatus();
      suppressTracks = true;
      setNativeCaptionsHidden(true);
      console.log(`${TAG} coursera: ${translated.length} cues ready`);
      tick();
    }

    // ---------- настройка текущей лекции ----------
    async function setupLecture(): Promise<void> {
      currentAbort?.abort();
      const abort = new AbortController();
      currentAbort = abort;
      const gen = ++generation;
      const alive = (): boolean =>
        !destroyed && gen === generation && !abort.signal.aborted && settings.enabled;

      // Снимок «уходящего» плеера ДО сброса: если привязанный <video> принадлежит
      // ДРУГОЙ лекции, его треки нельзя принимать за треки новой — React обновляет
      // DOM асинхронно после pushState. Владелец DOM — videoLectureKey (проверенный,
      // выставляется при приёме треков); пока он неизвестен (треки первой лекции ещё
      // не приняты), оцениваем по предыдущему URL-ключу. Именно videoLectureKey в
      // приоритете: при быстрой навигации A→B→A привязанный плеер всё ещё лекции A,
      // и исключать его треки нельзя (prevKey был бы 'B' и ошибся бы).
      const prevKey = currentLectureKey;
      const ref = getLectureRef();
      const key = getLectureKey();
      currentLectureKey = key;
      const excludeSrcPaths = new Set<string>();
      let outgoingVideo: HTMLVideoElement | null = null;
      const domOwner = videoLectureKey ?? prevKey;
      if (video && domOwner !== null && domOwner !== key) {
        outgoingVideo = video;
        for (const t of Array.from(video.querySelectorAll('track'))) {
          if (t.src) excludeSrcPaths.add(trackSrcPath(t));
        }
      }

      cues = null;
      activeCueIndex = -1;
      stopDomFallback();
      overlay.update('', '');
      overlay.hideStatus(); // иначе sticky-статус воскреснет при перемонтировании
      suppressTracks = false;
      restoreSuppressedTracks();
      setNativeCaptionsHidden(false);
      if (!settings.enabled) return;

      if (!ref) {
        console.log(`${TAG} coursera: not a lecture page (${location.pathname})`);
        // Вне лекции не держим привязку: на страницах курса бывают свои <video>.
        unbindVideo();
        videoLectureKey = null;
        overlay.destroy();
        return;
      }

      // Язык фиксируем на входе: кэш-ключ и перевод не должны разъехаться,
      // если пользователь сменит язык во время долгого перевода.
      const lang = settings.targetLang;

      try {
        const v = await waitForVideo(abort.signal);
        if (!alive()) return;
        bindVideo(v);

        overlay.showStatus('Перевожу субтитры…', false, true);

        // Ключ кэша по содержимому трека: подписанные URL субтитров истекают,
        // а стабильность их opaque id между сессиями не гарантирована.
        const keyForCues = (rawCues: Cue[]) => {
          const seed = `${rawCues.length}:${rawCues[0]!.text}`;
          return (engine: string): string =>
            `coursera:${ref.courseSlug}:${ref.itemId ?? 'x'}:${lang}:${engine}:${hashString(seed)}`;
        };

        // План А: <track>-элементы плеера / video.textTracks.
        const trackCues = await acquireTrackCues(excludeSrcPaths, outgoingVideo, abort.signal);
        if (!alive()) return;
        if (trackCues && trackCues.length > 0) {
          videoLectureKey = key; // треки приняты — DOM принадлежит этой лекции
          await activateTrack(trackCues, keyForCues(trackCues), lang, alive);
          return;
        }
        // Полный цикл ожидания прошёл — React уже заменил плеер; чьи бы треки
        // ни появились у <video> позже, они принадлежат текущей лекции.
        videoLectureKey = key;

        // План Б: onDemandLectureVideos.v1 (same-origin, куки CAUTH).
        if (ref.itemId) {
          console.log(`${TAG} track path unavailable, trying lecture videos API…`);
          const courseId = await resolveCourseId(ref.courseSlug, abort.signal);
          if (!alive()) return;
          if (courseId) {
            const vttUrl = await fetchApiVttUrl(courseId, ref.itemId, abort.signal);
            if (!alive()) return;
            if (vttUrl) {
              const vttText = await fetchVtt(vttUrl, abort.signal);
              if (!alive()) return;
              if (vttText !== null) {
                const rawCues = parseVtt(vttText);
                if (rawCues.length > 0) {
                  await activateTrack(rawCues, keyForCues(rawCues), lang, alive);
                  return;
                }
                console.warn(`${TAG} API VTT parsed to 0 cues`);
              }
            }
          }
        }

        // План В: построчный перевод по интерактивному транскрипту.
        startDomFallback();
      } catch (e) {
        if (abort.signal.aborted || destroyed) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`${TAG} lecture setup failed:`, e);
        overlay.showStatus(`Ошибка перевода: ${msg}`, true);
      }
    }

    // ---------- SPA-навигация между лекциями ----------
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      const key = getLectureKey();
      if (key !== currentLectureKey) {
        console.log(`${TAG} coursera: lecture changed → ${key}`);
        void setupLecture();
      }
    });

    // Плеер может пересоздать <video>/контейнер без смены URL; заодно
    // подстраховка на случай, если wxt:locationchange не сработал на pushState.
    videoPoll = window.setInterval(() => {
      if (destroyed || !settings.enabled) return;
      const key = getLectureKey();
      if (key !== currentLectureKey) {
        console.log(`${TAG} coursera: lecture changed (poll) → ${key}`);
        void setupLecture();
        return;
      }
      if (key === null) return; // вне лекции не привязываемся к случайным <video>
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
        currentAbort?.abort();
        cues = null;
        activeCueIndex = -1;
        suppressTracks = false;
        restoreSuppressedTracks();
        setNativeCaptionsHidden(false);
        stopDomFallback();
        overlay.update('', '');
        overlay.hideStatus();
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
    console.log(`${TAG} coursera content script loaded`);
    void setupLecture();
  },
});
