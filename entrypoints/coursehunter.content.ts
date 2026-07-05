import { defineContentScript } from 'wxt/utils/define-content-script';
import { settingsItem } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Settings, type TranslatedCue } from '@/lib/types';
import { SubtitleOverlay } from '@/lib/overlay';
import { parseVtt } from '@/lib/vtt';
import { requestTranslation } from '@/lib/messaging';
import { getCachedCues, setCachedCues, hashString } from '@/lib/cache';
import { translateCues } from '@/lib/pipeline';
import { chromeLocalProvider } from '@/lib/providers/chrome-local';

const TAG = '[course-translator]';
const SYNC_INTERVAL_MS = 250;
const SWITCH_DEBOUNCE_MS = 300;

/** Элемент из /api/v1/course/{id}/lessons. Поля могут отсутствовать. */
interface Lesson {
  id?: string;
  title?: string;
  file?: string;
  subtitle?: string;
  duration?: string;
}

/** courseId со страницы: [data-player] или скрытый input. */
function resolveCourseId(): string | null {
  const el = document.querySelector<HTMLElement>('[data-player]');
  const fromDataset = el?.dataset['courseId'];
  if (fromDataset) return fromDataset;
  const input = document.querySelector<HTMLInputElement>('input[name="course_id"]');
  return input?.value ? input.value : null;
}

/** Список уроков через внутренний API. 401/403 и прочие сбои → null (тихо). */
async function fetchLessons(courseId: string): Promise<Lesson[] | null> {
  try {
    const res = await fetch(`${location.origin}/api/v1/course/${courseId}/lessons`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      console.warn(`${TAG} lessons API returned ${res.status} — aborting`);
      return null;
    }
    const data: unknown = await res.json();
    return Array.isArray(data) ? (data as Lesson[]) : null;
  } catch (e) {
    console.warn(`${TAG} lessons API failed`, e);
    return null;
  }
}

/** Индекс активного урока по DOM; localStorage 'less' — лишь ненадёжный fallback. */
function getActiveLessonIndex(): number {
  try {
    const items = document.querySelectorAll('.lessons-item');
    const active = document.querySelector('.lessons-item_active');
    if (active) {
      const idx = Array.prototype.indexOf.call(items, active);
      if (idx >= 0) return idx;
    }
    // Fallback: формат ключа 'less' не верифицирован — берём только если это число.
    const raw = localStorage.getItem('less');
    if (raw !== null) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n < items.length) return n;
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * lesson.subtitle в синтаксисе PlayerJS: '[English]url' или '[L1]u1,[L2]u2' или ''.
 * Предпочитаем трек с /en/i в метке, иначе первый.
 */
function pickSubtitleUrl(subtitle: string | undefined): string | null {
  if (!subtitle) return null;
  const tracks: Array<{ label: string; url: string }> = [];
  const re = /\[([^\]]*)\]([^,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(subtitle)) !== null) {
    tracks.push({ label: m[1] ?? '', url: (m[2] ?? '').trim() });
  }
  if (tracks.length === 0) {
    // Без меток: возможно, просто голый URL.
    const bare = subtitle.trim();
    return /^https?:\/\//.test(bare) ? bare : null;
  }
  const en = tracks.find((t) => /en/i.test(t.label));
  return (en ?? tracks[0]!).url || null;
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

export default defineContentScript({
  matches: ['*://coursehunter.net/*', '*://*.coursehunter.net/*'],
  // В сборке для Chrome Web Store этот entrypoint исключён (см. wxt.config.ts).
  exclude: ['store'],

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
    let lastLessonIndex = -1;

    // Счётчик поколений + AbortController: устаревшая async-цепочка
    // не должна перетереть результат более новой.
    let generation = 0;
    let currentAbort: AbortController | null = null;

    let switchTimer: number | null = null;
    let syncInterval: number | null = null;
    let lessonObserver: MutationObserver | null = null;

    const cleanups: Array<() => void> = [];
    let destroyed = false;

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
      if (switchTimer !== null) clearTimeout(switchTimer);
      if (syncInterval !== null) clearInterval(syncInterval);
      lessonObserver?.disconnect();
      unbindVideo();
      overlay.destroy();
    });

    // ---------- страница курса? ----------
    const courseId = resolveCourseId();
    if (!courseId) {
      console.log(`${TAG} coursehunter: no course id on this page, idle`);
      return;
    }

    const lessons = await fetchLessons(courseId);
    if (destroyed) return;
    if (!lessons || lessons.length === 0) {
      console.warn(`${TAG} no lessons available for course ${courseId}, idle`);
      return;
    }
    console.log(`${TAG} course ${courseId}: ${lessons.length} lessons`);

    // ---------- синхронизация ----------
    function tick(): void {
      try {
        if (!settings.enabled || !cues || !video) return;
        const idx = findActiveCueIndex(cues, video.currentTime);
        if (idx === activeCueIndex) return; // трогаем DOM только при смене cue
        activeCueIndex = idx;
        if (idx === -1) {
          overlay.update('', '');
        } else {
          const c = cues[idx]!;
          overlay.update(c.text, c.translation);
          hideNativeCue(c.text);
        }
      } catch (e) {
        console.warn(`${TAG} sync tick failed`, e);
      }
    }

    /**
     * Спрятать нативный субтитр PlayerJS, иначе поверх видео висят три блока
     * текста (нативный EN + наш оригинал + перевод). PlayerJS рисует cue
     * в анонимных <pjsdiv> без стабильных классов и пересоздаёт их на каждый
     * cue, поэтому ищем по совпадению текста с активным cue и прячем на месте.
     */
    function hideNativeCue(cueText: string): void {
      const player = document.querySelector('#player');
      if (!player) return;
      const needle = cueText.replace(/\s+/g, ' ').trim();
      if (needle === '') return;
      for (const el of player.querySelectorAll<HTMLElement>('pjsdiv')) {
        if (el.childElementCount !== 0) continue; // ищем листовые узлы с текстом
        const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (text === needle) {
          // Прячем ближайший непрозрачный контейнер (фон подложки cue).
          const box = (el.parentElement?.tagName === 'PJSDIV' ? el.parentElement : el) as HTMLElement;
          box.style.visibility = 'hidden';
        }
      }
    }

    // ---------- привязка к <video> (PlayerJS может пересоздавать элемент) ----------
    function unbindVideo(): void {
      if (!video) return;
      video.removeEventListener('timeupdate', tick);
      video.removeEventListener('loadstart', onPossibleLessonSwitch);
      video = null;
    }

    function bindVideo(v: HTMLVideoElement): void {
      if (video === v) return;
      unbindVideo();
      video = v;
      v.addEventListener('timeupdate', tick);
      v.addEventListener('loadstart', onPossibleLessonSwitch);
    }

    // ---------- настройка текущего урока ----------
    async function setupLesson(): Promise<void> {
      currentAbort?.abort();
      const abort = new AbortController();
      currentAbort = abort;
      const gen = ++generation;
      const alive = (): boolean =>
        !destroyed && gen === generation && !abort.signal.aborted && settings.enabled;

      cues = null;
      activeCueIndex = -1;
      overlay.update('', '');
      if (!settings.enabled) return;

      try {
        const index = getActiveLessonIndex();
        const lesson = lessons![index];
        const vttUrl = pickSubtitleUrl(lesson?.subtitle);
        if (!vttUrl) {
          console.log(`${TAG} lesson ${index}: no subtitles`);
          // У многих курсов на coursehunter нет файлов субтитров вовсе —
          // сообщаем явно, иначе кажется, что расширение не работает.
          overlay.showStatus('У этого урока нет субтитров — переводить нечего');
          return;
        }

        overlay.showStatus('Перевожу субтитры…', false, true);

        const res = await fetch(vttUrl, { signal: abort.signal });
        if (!res.ok) throw new Error(`VTT fetch failed: ${res.status}`);
        const vttText = await res.text();
        if (!alive()) return;

        const rawCues = parseVtt(vttText);
        if (rawCues.length === 0) {
          console.log(`${TAG} lesson ${index}: empty VTT`);
          overlay.showStatus('Файл субтитров пуст — переводить нечего');
          return;
        }

        const lessonKey = lesson?.id ?? String(index);
        const keyFor = (engine: string): string =>
          `coursehunter:${courseId}:${lessonKey}:${settings.targetLang}:${engine}:${hashString(vttUrl)}`;

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
            // Любой сбой локального движка → fallback на google-free в background.
            console.warn(`${TAG} chrome-local failed, falling back to google-free`, e);
            if (!alive()) return;
            overlay.showStatus('Локальный переводчик недоступен — использую Google', false, true);
            const resp = await requestTranslation({
              cacheKey: keyFor('google-free'),
              cues: rawCues,
              targetLang: settings.targetLang,
              engine: 'google-free',
            });
            if (!resp.ok || !resp.cues) {
              throw new Error(resp.error ?? 'translation failed');
            }
            translated = resp.cues;
          }
        } else {
          const resp = await requestTranslation({
            cacheKey: keyFor(settings.engine),
            cues: rawCues,
            targetLang: settings.targetLang,
            engine: settings.engine,
          });
          if (!resp.ok || !resp.cues) {
            throw new Error(resp.error ?? 'translation failed');
          }
          translated = resp.cues;
        }

        if (!alive()) return;
        translated = [...translated].sort((a, b) => a.start - b.start);
        cues = translated;
        activeCueIndex = -1;
        overlay.hideStatus();
        console.log(`${TAG} lesson ${index}: ${translated.length} cues ready`);
        tick();
      } catch (e) {
        if (abort.signal.aborted || destroyed) return; // отменено — не ошибка
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`${TAG} lesson setup failed:`, e);
        overlay.showStatus(`Ошибка перевода: ${msg}`, true);
      }
    }

    // ---------- смена урока (SPA: страница не перезагружается) ----------
    function onPossibleLessonSwitch(): void {
      if (destroyed) return;
      if (switchTimer !== null) clearTimeout(switchTimer);
      switchTimer = window.setTimeout(() => {
        switchTimer = null;
        try {
          // PlayerJS может заменить сам <video> — перепривязываемся.
          const v = document.querySelector<HTMLVideoElement>('#player video');
          if (v && v !== video) bindVideo(v);
          const idx = getActiveLessonIndex();
          if (idx !== lastLessonIndex) {
            lastLessonIndex = idx;
            void setupLesson();
          }
        } catch (e) {
          console.warn(`${TAG} lesson switch handling failed`, e);
        }
      }, SWITCH_DEBOUNCE_MS);
    }

    // ---------- реакция на настройки ----------
    const unwatch = settingsItem.watch((next) => {
      try {
        const prev = settings;
        settings = next ?? { ...DEFAULT_SETTINGS };
        overlay.applySettings(settings);
        if (!settings.enabled) {
          currentAbort?.abort();
          cues = null;
          activeCueIndex = -1;
          overlay.update('', '');
          overlay.hideStatus();
          overlay.setVisible(false);
          return;
        }
        overlay.setVisible(true);
        if (
          !prev.enabled ||
          prev.engine !== settings.engine ||
          prev.targetLang !== settings.targetLang
        ) {
          void setupLesson();
        }
      } catch (e) {
        console.warn(`${TAG} settings watch failed`, e);
      }
    });
    cleanups.push(unwatch);

    // ---------- ждём появления <video> (PlayerJS грузится после клика) ----------
    const initialVideo = await new Promise<HTMLVideoElement | null>((resolve) => {
      const found = document.querySelector<HTMLVideoElement>('#player video');
      if (found) {
        resolve(found);
        return;
      }
      const mo = new MutationObserver(() => {
        const v = document.querySelector<HTMLVideoElement>('#player video');
        if (v) {
          mo.disconnect();
          resolve(v);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      cleanups.push(() => {
        mo.disconnect();
        resolve(null); // прерываем ожидание при teardown
      });
    });
    if (destroyed || !initialVideo) return;

    // ---------- монтирование и запуск ----------
    try {
      const player = document.querySelector<HTMLElement>('#player');
      overlay.mount(player ?? initialVideo.parentElement ?? document.body);
      overlay.applySettings(settings);
      overlay.setVisible(settings.enabled);
    } catch (e) {
      console.warn(`${TAG} overlay mount failed`, e);
      return;
    }

    bindVideo(initialVideo);

    // Наблюдаем смену класса lessons-item_active в списке уроков.
    try {
      const firstItem = document.querySelector('.lessons-item');
      const listRoot: Node = firstItem?.parentElement ?? document.body;
      lessonObserver = new MutationObserver(onPossibleLessonSwitch);
      lessonObserver.observe(listRoot, {
        attributes: true,
        attributeFilter: ['class'],
        subtree: true,
      });
    } catch (e) {
      console.warn(`${TAG} lesson list observer failed`, e);
    }

    // 250 мс интервал — страховка на случай пропущенных timeupdate.
    syncInterval = window.setInterval(tick, SYNC_INTERVAL_MS);

    lastLessonIndex = getActiveLessonIndex();
    if (settings.enabled) {
      await setupLesson();
    }
  },
});
