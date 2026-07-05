import type { DisplayMode, Settings } from '@/lib/types';

const STATUS_HIDE_MS = 4000;
const STATUS_HIDE_ERROR_MS = 8000;

/**
 * Framework-free оверлей субтитров. Рисуется в open shadow root,
 * чтобы стили страницы (и PlayerJS) не могли его сломать.
 * Все тексты выставляются только через textContent — без innerHTML.
 */
export class SubtitleOverlay {
  private host: HTMLDivElement | null = null;
  private line1: HTMLDivElement | null = null; // оригинал
  private line2: HTMLDivElement | null = null; // перевод
  private statusEl: HTMLDivElement | null = null;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;

  private mode: DisplayMode = 'dual';
  private lastOriginal = '';
  private lastTranslation = '';
  // Статус переживает перемонтирование (SPA пересоздаёт контейнер плеера).
  private lastStatusText = '';
  private lastStatusIsError = false;
  private lastStatusSticky = false;

  /** Создать host с shadow root и вставить в контейнер (обычно #player). */
  mount(container: HTMLElement): void {
    if (this.host) this.destroy();

    const host = document.createElement('div');
    host.style.cssText =
      'position:absolute;left:0;right:0;bottom:10%;z-index:2147483646;' +
      'pointer-events:none;text-align:center;';

    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .wrap {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        font-family: Arial, Helvetica, sans-serif;
      }
      .line {
        display: inline-block;
        max-width: 88%;
        margin: 0 auto;
        padding: 2px 10px;
        border-radius: 4px;
        background: rgba(0, 0, 0, .72);
        line-height: 1.35;
        text-shadow: 0 1px 2px rgba(0, 0, 0, .8);
        white-space: pre-wrap;
      }
      .orig { color: #ffffff; }
      .tran { color: #ffd966; }
      .status {
        display: inline-block;
        margin: 0 auto 4px;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.4;
        color: #ffffff;
        background: rgba(20, 20, 20, .8);
      }
      .status.error { background: rgba(160, 30, 30, .9); }
    `;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';

    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.style.display = 'none';

    const line1 = document.createElement('div');
    line1.className = 'line orig';
    line1.style.display = 'none';

    const line2 = document.createElement('div');
    line2.className = 'line tran';
    line2.style.display = 'none';

    wrap.append(statusEl, line1, line2);
    root.append(style, wrap);

    // Контейнеру нужен position != static, чтобы absolute-host лёг поверх видео.
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(host);

    this.host = host;
    this.line1 = line1;
    this.line2 = line2;
    this.statusEl = statusEl;
    this.render();
    // Восстановить статус, если оверлей перемонтирован посреди работы.
    if (this.lastStatusText !== '') {
      this.showStatus(this.lastStatusText, this.lastStatusIsError, this.lastStatusSticky);
    }
  }

  /** Смонтирован ли оверлей именно в этот контейнер и жив ли он в DOM. */
  isMountedIn(container: HTMLElement): boolean {
    return this.host !== null && this.host.isConnected && this.host.parentElement === container;
  }

  /** Показать пару оригинал/перевод. Пустая строка скрывает соответствующую линию. */
  update(original: string, translation: string): void {
    this.lastOriginal = original;
    this.lastTranslation = translation;
    this.render();
  }

  /** Применить настройки: размер шрифта и режим отображения. */
  applySettings(s: Settings): void {
    this.mode = s.displayMode;
    if (this.line1) this.line1.style.fontSize = `${Math.round(s.fontSizePx * 0.85)}px`;
    if (this.line2) this.line2.style.fontSize = `${s.fontSizePx}px`;
    this.render();
  }

  setVisible(v: boolean): void {
    if (this.host) this.host.style.display = v ? '' : 'none';
  }

  /**
   * Статус-бейдж (прогресс/ошибки). Авто-скрытие через 4 с (ошибки — 8 с,
   * красный фон); sticky=true — висит до следующего showStatus/hideStatus
   * (например, «Перевожу…» на время долгого перевода). Пустой текст скрывает сразу.
   */
  showStatus(text: string, isError = false, sticky = false): void {
    this.lastStatusText = text;
    this.lastStatusIsError = isError;
    this.lastStatusSticky = sticky;
    if (!this.statusEl) return;
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    if (text === '') {
      this.statusEl.style.display = 'none';
      return;
    }
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', isError);
    this.statusEl.style.display = '';
    if (!sticky) {
      this.statusTimer = setTimeout(
        () => {
          if (this.statusEl) this.statusEl.style.display = 'none';
          this.statusTimer = null;
          this.lastStatusText = ''; // скрытый статус не должен воскресать при перемонтировании
        },
        isError ? STATUS_HIDE_ERROR_MS : STATUS_HIDE_MS,
      );
    }
  }

  /** Скрыть статус-бейдж немедленно. */
  hideStatus(): void {
    this.showStatus('');
  }

  destroy(): void {
    if (this.statusTimer !== null) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
    }
    this.host?.remove();
    this.host = null;
    this.line1 = null;
    this.line2 = null;
    this.statusEl = null;
  }

  /** Перерисовать линии с учётом режима и пустых строк. */
  private render(): void {
    if (!this.line1 || !this.line2) return;
    const showOrig = this.mode === 'dual' && this.lastOriginal !== '';
    this.line1.textContent = this.lastOriginal;
    this.line1.style.display = showOrig ? '' : 'none';
    this.line2.textContent = this.lastTranslation;
    this.line2.style.display = this.lastTranslation !== '' ? '' : 'none';
  }
}
