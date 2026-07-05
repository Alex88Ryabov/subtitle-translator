import type { Cue } from '@/lib/types';

/**
 * Парсер WebVTT (толерантный): необязательные часы, запятая как разделитель
 * миллисекунд (SRT-стиль), id-строки перед таймкодом, NOTE/STYLE/REGION-блоки,
 * inline-теги и HTML-сущности.
 */

/** "HH:MM:SS.mmm" или "MM:SS.mmm" (также с запятой) → секунды. null — не таймкод. */
function parseTimestamp(ts: string): number | null {
  const m = /^(?:(\d{1,4}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(ts.trim());
  if (!m) return null;
  const hours = m[1] ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const millis = Number(m[4].padEnd(3, '0'));
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

const TIMING_LINE_RE =
  /^\s*((?:\d{1,4}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d{1,4}:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:\s.*)?$/;

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  // &amp; декодируем последним, чтобы не раскодировать дважды (&amp;lt; → &lt;).
  const out = text.replace(/&(lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m);
  return out.replace(/&amp;/g, '&');
}

/** Очистка текста cue: убрать <...>-теги, декодировать сущности, схлопнуть пробелы. */
function cleanCueText(raw: string): string {
  const noTags = raw.replace(/<[^>]*>/g, '');
  return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

/** Строка начинается с ключевого слова блока (NOTE / STYLE / REGION)? */
function isBlockKeyword(line: string): boolean {
  return /^(NOTE|STYLE|REGION)(\s|$)/.test(line);
}

export function parseVtt(input: string): Cue[] {
  // BOM + унификация переводов строки (\r\n, \r → \n).
  const lines = input.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const cues: Cue[] = [];
  let i = 0;

  // Заголовок WEBVTT + метаданные до первой пустой строки.
  if (lines[0] !== undefined && /^WEBVTT(\s|$)/.test(lines[0].trim())) {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].includes('-->')) i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === '') {
      i++;
      continue;
    }

    // NOTE / STYLE / REGION — пропустить блок целиком (до пустой строки).
    if (isBlockKeyword(line)) {
      while (i < lines.length && lines[i].trim() !== '') i++;
      continue;
    }

    // Опциональная id-строка перед таймкодом.
    let timingMatch = TIMING_LINE_RE.exec(line);
    if (!timingMatch) {
      const next = lines[i + 1];
      if (next !== undefined && (timingMatch = TIMING_LINE_RE.exec(next.trim()))) {
        i++; // строка была id, таймкод — следующая
      } else {
        i++; // мусорная строка вне cue — пропускаем
        continue;
      }
    }

    const start = parseTimestamp(timingMatch[1]);
    const end = parseTimestamp(timingMatch[2]);
    i++; // за таймкод

    // Текст cue: все непустые строки до пустой; многострочный текст склеиваем пробелом.
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }

    if (start === null || end === null) continue;
    const text = cleanCueText(textLines.join(' '));
    if (text === '' || end <= start) continue;
    cues.push({ start, end, text });
  }

  return cues.sort((a, b) => a.start - b.start);
}
