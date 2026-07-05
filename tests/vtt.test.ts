import { describe, expect, it } from 'vitest';
import { parseVtt } from '@/lib/vtt';

describe('parseVtt', () => {
  it('parses a minimal WEBVTT file', () => {
    const input = `WEBVTT

00:00:01.000 --> 00:00:03.000
Hello world
`;
    expect(parseVtt(input)).toEqual([{ start: 1, end: 3, text: 'Hello world' }]);
  });

  it('parses header with trailing text and metadata lines until first blank line', () => {
    const input = `WEBVTT - Some description
Kind: captions
Language: en

00:00:01.000 --> 00:00:02.000
First cue
`;
    const cues = parseVtt(input);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('First cue');
  });

  it('handles optional BOM before WEBVTT', () => {
    const input = '﻿' + 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBOM cue\n';
    const cues = parseVtt(input);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('BOM cue');
  });

  it('tolerates \\r\\n and \\r line endings', () => {
    const crlf = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nCRLF cue\r\n';
    const cr = 'WEBVTT\r\r00:00:01.000 --> 00:00:02.000\rCR cue\r';
    expect(parseVtt(crlf)).toEqual([{ start: 1, end: 2, text: 'CRLF cue' }]);
    expect(parseVtt(cr)).toEqual([{ start: 1, end: 2, text: 'CR cue' }]);
  });

  it('skips NOTE blocks (single-line and multi-line)', () => {
    const input = `WEBVTT

NOTE this is a single note

NOTE
This is a multi-line note.
It continues here.

00:00:01.000 --> 00:00:02.000
Real cue
`;
    const cues = parseVtt(input);
    expect(cues).toEqual([{ start: 1, end: 2, text: 'Real cue' }]);
  });

  it('skips STYLE and REGION blocks', () => {
    const input = `WEBVTT

STYLE
::cue { color: yellow; }

REGION
id:fred
width:40%

00:00:01.000 --> 00:00:02.000
After blocks
`;
    expect(parseVtt(input)).toEqual([{ start: 1, end: 2, text: 'After blocks' }]);
  });

  it('supports numeric and arbitrary string cue ids', () => {
    const input = `WEBVTT

1
00:00:01.000 --> 00:00:02.000
Numeric id

intro-slide 7
00:00:03.000 --> 00:00:04.000
String id
`;
    const cues = parseVtt(input);
    expect(cues).toEqual([
      { start: 1, end: 2, text: 'Numeric id' },
      { start: 3, end: 4, text: 'String id' },
    ]);
  });

  it('parses timestamps without hours (MM:SS.mmm)', () => {
    const input = `WEBVTT

01:05.500 --> 01:07.250
No hours
`;
    expect(parseVtt(input)).toEqual([{ start: 65.5, end: 67.25, text: 'No hours' }]);
  });

  it('parses hour timestamps correctly', () => {
    const input = `WEBVTT

01:02:03.400 --> 01:02:04.500
With hours
`;
    expect(parseVtt(input)).toEqual([
      { start: 3723.4, end: 3724.5, text: 'With hours' },
    ]);
  });

  it('tolerates comma decimals (SRT style)', () => {
    const input = `WEBVTT

00:00:01,000 --> 00:00:02,500
Comma cue
`;
    expect(parseVtt(input)).toEqual([{ start: 1, end: 2.5, text: 'Comma cue' }]);
  });

  it('ignores cue settings after the end timestamp', () => {
    const input = `WEBVTT

00:00:01.000 --> 00:00:02.000 position:10%,line-left align:left size:35%
Settings cue
`;
    expect(parseVtt(input)).toEqual([{ start: 1, end: 2, text: 'Settings cue' }]);
  });

  it('joins multi-line cue text with a single space', () => {
    const input = `WEBVTT

00:00:01.000 --> 00:00:02.000
First line
second line
third line
`;
    expect(parseVtt(input)[0].text).toBe('First line second line third line');
  });

  it('strips <i>, <b>, <c.classname>, <v Speaker> and inline timestamp tags', () => {
    const input = `WEBVTT

00:00:01.000 --> 00:00:02.000
<v Mr. Smith><i>Hello</i> <b>bold</b> <c.yellow>colored</c> <00:00:01.500>timed
`;
    expect(parseVtt(input)[0].text).toBe('Hello bold colored timed');
  });

  it('decodes HTML entities', () => {
    const input = `WEBVTT

00:00:01.000 --> 00:00:02.000
Tom &amp; Jerry &lt;3 &quot;quotes&quot; it&#39;s &apos;fine&apos;&nbsp;ok &gt; all
`;
    expect(parseVtt(input)[0].text).toBe(
      'Tom & Jerry <3 "quotes" it\'s \'fine\' ok > all',
    );
  });

  it('collapses whitespace runs and trims', () => {
    const input = `WEBVTT

00:00:01.000 --> 00:00:02.000
  Hello\t\t   world
`;
    expect(parseVtt(input)[0].text).toBe('Hello world');
  });

  it('drops cues that are empty after tag stripping', () => {
    const input = `WEBVTT

00:00:01.000 --> 00:00:02.000
<c.silent></c>

00:00:03.000 --> 00:00:04.000
Kept
`;
    const cues = parseVtt(input);
    expect(cues).toEqual([{ start: 3, end: 4, text: 'Kept' }]);
  });

  it('drops cues whose end <= start', () => {
    const input = `WEBVTT

00:00:05.000 --> 00:00:05.000
Zero duration

00:00:07.000 --> 00:00:06.000
Negative duration

00:00:01.000 --> 00:00:02.000
Valid
`;
    expect(parseVtt(input)).toEqual([{ start: 1, end: 2, text: 'Valid' }]);
  });

  it('returns cues sorted by start time', () => {
    const input = `WEBVTT

00:00:10.000 --> 00:00:11.000
Third

00:00:01.000 --> 00:00:02.000
First

00:00:05.000 --> 00:00:06.000
Second
`;
    expect(parseVtt(input).map((c) => c.text)).toEqual(['First', 'Second', 'Third']);
  });

  it('parses a body without WEBVTT header (tolerant / SRT-like)', () => {
    const input = `1
00:00:01,000 --> 00:00:02,000
SRT style cue
`;
    expect(parseVtt(input)).toEqual([{ start: 1, end: 2, text: 'SRT style cue' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('WEBVTT\n\n')).toEqual([]);
  });
});
