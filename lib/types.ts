/** Одна реплика субтитров. Времена в секундах. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Реплика с переводом. */
export interface TranslatedCue extends Cue {
  translation: string;
}

export type TargetLang = 'uk' | 'ru';

export type DisplayMode = 'dual' | 'translation-only';

/** Движки перевода. 'google-free' работает в background, 'chrome-local' — в content script (web API). */
export type EngineId = 'google-free' | 'chrome-local';

export interface Settings {
  enabled: boolean;
  targetLang: TargetLang;
  displayMode: DisplayMode;
  engine: EngineId;
  /** Размер шрифта оверлея, px. */
  fontSizePx: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  targetLang: 'uk',
  displayMode: 'dual',
  engine: 'google-free',
  fontSizePx: 20,
};

/** Предложение, собранное из последовательных cue (для качественного перевода). */
export interface Sentence {
  /** Склеенный текст предложения. */
  text: string;
  /** Индексы cue (в исходном массиве), из которых собрано предложение. */
  cueIndexes: number[];
}
