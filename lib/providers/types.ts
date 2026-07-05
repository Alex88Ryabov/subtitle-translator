import type { EngineId, TargetLang } from '@/lib/types';

/**
 * Движок перевода. Контракт: translateBatch возвращает массив ТОЙ ЖЕ длины,
 * что и texts — перевод i-го элемента на позиции i. Бросает Error при недоступности.
 */
export interface TranslationProvider {
  id: EngineId;
  translateBatch(texts: string[], targetLang: TargetLang): Promise<string[]>;
}
