import { browser } from 'wxt/browser';
import type { Cue, EngineId, TargetLang, TranslatedCue } from '@/lib/types';

/** Запрос content script → background на перевод набора cue. */
export interface TranslateCuesRequest {
  type: 'TRANSLATE_CUES';
  /** Ключ кэша, например 'coursehunter:700:c7001:uk:google-free'. */
  cacheKey: string;
  cues: Cue[];
  targetLang: TargetLang;
  engine: EngineId;
}

export interface TranslateCuesResponse {
  ok: boolean;
  cues?: TranslatedCue[];
  error?: string;
}

/** Запрос content script → background: скачать текст по URL (обход CORS через host_permissions). */
export interface FetchTextRequest {
  type: 'FETCH_TEXT';
  url: string;
}

export interface FetchTextResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

export type BgRequest = TranslateCuesRequest | FetchTextRequest;

/** Отправить cues в background на перевод (с кэшированием там). */
export async function requestTranslation(
  req: Omit<TranslateCuesRequest, 'type'>,
): Promise<TranslateCuesResponse> {
  try {
    return (await browser.runtime.sendMessage({
      type: 'TRANSLATE_CUES',
      ...req,
    } satisfies TranslateCuesRequest)) as TranslateCuesResponse;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Скачать текст (например, VTT с CDN) через background — там host_permissions снимают CORS. */
export async function requestText(url: string): Promise<FetchTextResponse> {
  try {
    return (await browser.runtime.sendMessage({
      type: 'FETCH_TEXT',
      url,
    } satisfies FetchTextRequest)) as FetchTextResponse;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
