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

export type BgRequest = TranslateCuesRequest;

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
