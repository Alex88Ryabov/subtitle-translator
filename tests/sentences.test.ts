import { describe, expect, it } from 'vitest';
import { mergeCuesIntoSentences, splitTranslationsAcrossCues } from '@/lib/sentences';
import type { Cue, Sentence } from '@/lib/types';

/** Cue-фабрика: подряд идущие 2-секундные cue без пауз. */
function makeCues(texts: string[], gap = 0): Cue[] {
  return texts.map((text, i) => ({
    start: i * (2 + gap),
    end: i * (2 + gap) + 2,
    text,
  }));
}

describe('mergeCuesIntoSentences', () => {
  it('merges mid-sentence continuations into one sentence', () => {
    const cues = makeCues(['So today we are', 'going to learn about', 'closures in JavaScript.']);
    const sentences = mergeCuesIntoSentences(cues);
    expect(sentences).toEqual([
      {
        text: 'So today we are going to learn about closures in JavaScript.',
        cueIndexes: [0, 1, 2],
      },
    ]);
  });

  it('splits at terminal punctuation (. ! ? …)', () => {
    const cues = makeCues(['First sentence.', 'Second one!', 'Third?', 'Fourth…', 'tail no punct']);
    const sentences = mergeCuesIntoSentences(cues);
    expect(sentences.map((s) => s.cueIndexes)).toEqual([[0], [1], [2], [3], [4]]);
  });

  it('treats closing quotes/brackets after terminal punctuation as a boundary', () => {
    const cues = makeCues(['He said "stop."', 'Then he left.', 'It was (finally over.)', 'done']);
    const sentences = mergeCuesIntoSentences(cues);
    expect(sentences.map((s) => s.cueIndexes)).toEqual([[0], [1], [2], [3]]);
  });

  it('does not split on non-terminal punctuation (comma, colon)', () => {
    const cues = makeCues(['First part,', 'second part:', 'third part.']);
    const sentences = mergeCuesIntoSentences(cues);
    expect(sentences).toHaveLength(1);
    expect(sentences[0].cueIndexes).toEqual([0, 1, 2]);
  });

  it('splits when gap to next cue exceeds 3 seconds', () => {
    const cues: Cue[] = [
      { start: 0, end: 2, text: 'part one' },
      { start: 6, end: 8, text: 'part two' }, // gap 4s > 3s
      { start: 8.5, end: 10, text: 'part three' },
    ];
    const sentences = mergeCuesIntoSentences(cues);
    expect(sentences.map((s) => s.cueIndexes)).toEqual([[0], [1, 2]]);
  });

  it('does not split when gap is exactly 3 seconds or less', () => {
    const cues: Cue[] = [
      { start: 0, end: 2, text: 'part one' },
      { start: 5, end: 7, text: 'part two' }, // gap ровно 3s — не граница
    ];
    expect(mergeCuesIntoSentences(cues)).toHaveLength(1);
  });

  it('caps a sentence at 8 cues', () => {
    const cues = makeCues(Array.from({ length: 10 }, (_, i) => `word${i}`));
    const sentences = mergeCuesIntoSentences(cues);
    expect(sentences.map((s) => s.cueIndexes)).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9],
    ]);
  });

  it('caps a sentence at 400 joined chars', () => {
    const chunk = 'a'.repeat(150); // без терминальной пунктуации
    const cues = makeCues([chunk, chunk, chunk, chunk]);
    const sentences = mergeCuesIntoSentences(cues);
    // 150 → 301 (>400? нет) → 452 > 400: граница после 3-го cue
    expect(sentences.map((s) => s.cueIndexes)).toEqual([[0, 1, 2], [3]]);
    expect(sentences[0].text).toBe([chunk, chunk, chunk].join(' '));
  });

  it('covers every cue index exactly once, in order', () => {
    const cues = makeCues([
      'One.',
      'two continues',
      'and ends!',
      'Another one',
      'still going',
      'done?',
    ]);
    const sentences = mergeCuesIntoSentences(cues);
    const allIndexes = sentences.flatMap((s) => s.cueIndexes);
    expect(allIndexes).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('returns [] for empty input', () => {
    expect(mergeCuesIntoSentences([])).toEqual([]);
  });

  it('sentence text is cue texts joined with a single space', () => {
    const cues = makeCues(['hello', 'world.']);
    expect(mergeCuesIntoSentences(cues)[0].text).toBe('hello world.');
  });
});

describe('splitTranslationsAcrossCues', () => {
  it('gives a single-cue sentence the whole translation', () => {
    const cues = makeCues(['Hello world.']);
    const sentences: Sentence[] = [{ text: 'Hello world.', cueIndexes: [0] }];
    const result = splitTranslationsAcrossCues(cues, sentences, ['Привіт, світе.']);
    expect(result).toEqual([{ ...cues[0], translation: 'Привіт, світе.' }]);
  });

  it('preserves start/end/text and length/order of the original cues', () => {
    const cues = makeCues(['abc', 'defgh.']);
    const sentences = mergeCuesIntoSentences(cues);
    const result = splitTranslationsAcrossCues(cues, sentences, ['один два три']);
    expect(result).toHaveLength(cues.length);
    result.forEach((tc, i) => {
      expect(tc.start).toBe(cues[i].start);
      expect(tc.end).toBe(cues[i].end);
      expect(tc.text).toBe(cues[i].text);
    });
  });

  it('distributes words proportionally to original cue char lengths', () => {
    // Длины 10 и 30 → примерно 1/4 и 3/4 слов
    const cues = makeCues(['aaaaaaaaaa', 'b'.repeat(30) + '.']);
    const sentences: Sentence[] = [
      { text: cues[0].text + ' ' + cues[1].text, cueIndexes: [0, 1] },
    ];
    const translation = 'w1 w2 w3 w4 w5 w6 w7 w8';
    const [first, second] = splitTranslationsAcrossCues(cues, sentences, [translation]);
    expect(first.translation).toBe('w1 w2');
    expect(second.translation).toBe('w3 w4 w5 w6 w7 w8');
  });

  it('conserves words: per-cue translations rejoin to the original translation', () => {
    const cues = makeCues(['short', 'a much longer piece of original text', 'mid size.']);
    const sentences = mergeCuesIntoSentences(cues);
    const translation = 'один два три чотири п’ять шість сім вісім дев’ять десять';
    const result = splitTranslationsAcrossCues(cues, sentences, [translation]);
    const rejoined = result
      .map((c) => c.translation)
      .filter((t) => t !== '')
      .join(' ');
    expect(rejoined).toBe(translation);
  });

  it('gives every cue >= 1 word when word count >= cue count', () => {
    const cues = makeCues(['x', 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyy', 'z.']);
    const sentences = mergeCuesIntoSentences(cues);
    const translation = 'a b c'; // ровно по числу cue
    const result = splitTranslationsAcrossCues(cues, sentences, [translation]);
    for (const tc of result) {
      expect(tc.translation.split(' ').filter(Boolean).length).toBeGreaterThanOrEqual(1);
    }
    expect(result.map((c) => c.translation).join(' ')).toBe(translation);
  });

  it('handles a single word across many cues (some cues get empty translation)', () => {
    const cues = makeCues(['one', 'two', 'three.']);
    const sentences = mergeCuesIntoSentences(cues);
    const result = splitTranslationsAcrossCues(cues, sentences, ['слово']);
    const nonEmpty = result.map((c) => c.translation).filter((t) => t !== '');
    expect(nonEmpty).toEqual(['слово']); // слово ровно один раз, без дублей
  });

  it('handles fewer words than cues without losing or duplicating words', () => {
    const cues = makeCues(['aaaa', 'bbbb', 'cccc', 'dddd.']);
    const sentences = mergeCuesIntoSentences(cues);
    const translation = 'раз два';
    const result = splitTranslationsAcrossCues(cues, sentences, [translation]);
    const rejoined = result
      .map((c) => c.translation)
      .filter((t) => t !== '')
      .join(' ');
    expect(rejoined).toBe(translation);
  });

  it('handles empty translations', () => {
    const cues = makeCues(['one', 'two.']);
    const sentences = mergeCuesIntoSentences(cues);
    const result = splitTranslationsAcrossCues(cues, sentences, ['']);
    expect(result.map((c) => c.translation)).toEqual(['', '']);
  });

  it('gives cues not covered by any sentence an empty translation', () => {
    const cues = makeCues(['covered.', 'not covered']);
    const sentences: Sentence[] = [{ text: 'covered.', cueIndexes: [0] }];
    const result = splitTranslationsAcrossCues(cues, sentences, ['переклад']);
    expect(result[0].translation).toBe('переклад');
    expect(result[1].translation).toBe('');
  });

  it('processes multiple sentences independently', () => {
    const cues = makeCues(['First part', 'ends here.', 'Second one.']);
    const sentences = mergeCuesIntoSentences(cues);
    expect(sentences).toHaveLength(2);
    const result = splitTranslationsAcrossCues(cues, sentences, [
      'перше речення тут закінчується',
      'друге речення',
    ]);
    expect(
      result
        .slice(0, 2)
        .map((c) => c.translation)
        .join(' '),
    ).toBe('перше речення тут закінчується');
    expect(result[2].translation).toBe('друге речення');
  });

  it('normalizes irregular whitespace in translation when splitting across cues', () => {
    const cues = makeCues(['aaa', 'bbb.']);
    const sentences = mergeCuesIntoSentences(cues);
    const result = splitTranslationsAcrossCues(cues, sentences, ['  раз   два  ']);
    const rejoined = result
      .map((c) => c.translation)
      .filter((t) => t !== '')
      .join(' ');
    expect(rejoined).toBe('раз два');
  });

  it('returns [] for empty cues', () => {
    expect(splitTranslationsAcrossCues([], [], [])).toEqual([]);
  });
});
