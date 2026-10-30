import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTranscript, importTranscriptFile, loadTranscript, saveTranscript,
  deleteTranscript, updateTranscriptCue, exportTranscript,
  MAX_TRANSCRIPT_BYTES, MAX_TRANSCRIPT_CUES, TRANSCRIPT_STORAGE_PREFIX,
} from '../src/recordings/transcript.ts';

const srt = '2\r\n00:00:04,200 --> 00:00:06,100\r\nAté já!\r\n\r\n1\r\n00:00:00,500 --> 00:00:03,250\r\nOlá, criadores.\r\nVamos começar?\r\n';
const vtt = '\uFEFFWEBVTT - português\nKind: captions\nLanguage: pt-BR\n\nNOTE\nTexto que não é fala.\n\nSTYLE\n::cue { color: white; }\n\nintro\n00:00.500 --> 00:03.250 align:start position:0%\n<v Felipe><b>Olá</b>, criadores &amp; amigas.</v>\n\n00:04.200 --> 00:06.100\nAté já!';

test('SRT import preserves real cue times, Portuguese and multiline text, and orders cues', () => {
  const transcript = parseTranscript(srt, { fileName: 'apresentação.srt', durationSeconds: 8 });
  assert.equal(transcript.sourceName, 'apresentação.srt');
  assert.deepEqual(transcript.cues.map(({ start, end, text }) => ({ start, end, text })), [
    { start: 0.5, end: 3.25, text: 'Olá, criadores.\nVamos começar?' },
    { start: 4.2, end: 6.1, text: 'Até já!' },
  ]);
  assert.equal(new Set(transcript.cues.map(cue => cue.id)).size, 2);
});

test('WebVTT import handles metadata, comments, cue settings and formatting without inventing words', () => {
  const transcript = parseTranscript(vtt);
  assert.equal(transcript.cues.length, 2);
  assert.equal(transcript.cues[0].text, 'Olá, criadores & amigas.');
  assert.equal(transcript.cues[0].start, 0.5);
  assert.equal('words' in transcript.cues[0], false);
});

test('rejects malformed, inverted, empty and out-of-range captions rather than guessing timings', () => {
  for (const source of [
    '', 'WEBVTT\n\nNOTE\nOnly a note.', 'Texto sem marcação de tempo',
    '1\n00:65:00,000 --> 00:66:00,000\nOlá',
    '1\n00:00:03,000 --> 00:00:02,000\nOlá',
    '1\n00:00:03,000 --> 00:00:03,000\nOlá',
    '1\n-00:00:01,000 --> 00:00:03,000\nOlá',
    '1\n00:00:01,12 --> 00:00:03,000\nOlá',
    '1\n1000:00:00,000 --> 1000:00:03,000\nOlá',
    '1\n00:00:01,000 --> 00:00:03,000\n<i></i>',
    'identificador\noutro identificador\n00:00:01,000 --> 00:00:03,000\nOlá',
  ]) assert.throws(() => parseTranscript(source), Error, source);
  assert.throws(() => parseTranscript(srt, { durationSeconds: 4 }), /ultrapassam/);
  assert.throws(() => parseTranscript('1\n00:00:02,000 --> 00:00:03,000\nOlá', { durationSeconds: 2 }), /ultrapassam/);
  const rounded = parseTranscript('1\n00:00:00,000 --> 00:00:02,150\nOlá', { durationSeconds: 2 });
  assert.equal(rounded.cues[0].end, 2);
});

test('file import enforces type, byte size and cue count limits', async () => {
  await assert.rejects(importTranscriptFile(new File([srt], 'legenda.txt')), /\.srt ou \.vtt/);
  await assert.rejects(importTranscriptFile(new File(['x'.repeat(MAX_TRANSCRIPT_BYTES + 1)], 'legenda.srt')), /5 MB/);
  assert.throws(() => parseTranscript('á'.repeat(MAX_TRANSCRIPT_BYTES / 2 + 1)), /5 MB/);
  const tooMany = Array.from({ length: MAX_TRANSCRIPT_CUES + 1 }, () => '00:00.000 --> 00:01.000\nOlá').join('\n\n');
  assert.throws(() => parseTranscript('WEBVTT\n\n' + tooMany), /20\.000/);
  const transcript = await importTranscriptFile(new File([srt], 'legenda.SRT'), 8);
  assert.equal(transcript.cues.length, 2);
});

test('text corrections retain immutable original speech and timing; export round-trips timestamps', () => {
  const original = parseTranscript(srt);
  const cue = original.cues[0];
  const corrected = updateTranscriptCue(original, cue.id, 'Olá, criadores & amigas <3.');
  const correctedTwice = updateTranscriptCue(corrected, cue.id, 'Olá, comunidade!');
  assert.equal(original.cues[0].text, 'Olá, criadores.\nVamos começar?');
  assert.equal(corrected.cues[0].originalText, cue.text);
  assert.equal(correctedTwice.cues[0].originalText, cue.text);
  assert.equal(corrected.cues[0].start, cue.start);
  assert.equal(corrected.cues[0].end, cue.end);
  assert.throws(() => updateTranscriptCue(original, cue.id, '   '), /vazio/);
  assert.throws(() => updateTranscriptCue(original, 'missing', 'Olá'), /não encontrado/);
  for (const format of ['srt', 'vtt']) {
    const exported = exportTranscript(corrected, format);
    assert.ok(exported.includes('&amp; amigas &lt;3.'));
    const imported = parseTranscript(exported);
    assert.deepEqual(imported.cues.map(({ start, end, text }) => ({ start, end, text })), corrected.cues.map(({ start, end, text }) => ({ start, end, text })));
  }
  assert.equal(exportTranscript(corrected, 'txt'), 'Olá, criadores & amigas <3.\n\nAté já!\n');
});

test('local persistence survives reloads, isolates takes and handles malformed/quota failures', () => {
  const values = new Map();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  try {
    const transcript = parseTranscript(srt);
    const saved = saveTranscript('take-a', transcript);
    assert.deepEqual(loadTranscript('take-a'), saved);
    assert.equal(loadTranscript('take-b'), null);
    saveTranscript('take-b', transcript);
    deleteTranscript('take-a');
    assert.equal(loadTranscript('take-a'), null);
    assert.ok(loadTranscript('take-b'));
    values.set(TRANSCRIPT_STORAGE_PREFIX + 'broken', '{not-json');
    assert.equal(loadTranscript('broken'), null);
    values.set(TRANSCRIPT_STORAGE_PREFIX + 'broken', JSON.stringify({ ...transcript, cues: [{ ...transcript.cues[0], start: -1 }] }));
    assert.equal(loadTranscript('broken'), null);
    storage.setItem = () => { throw new DOMException('Quota exceeded', 'QuotaExceededError'); };
    assert.throws(() => saveTranscript('take-b', transcript), /espaço disponível/);
    storage.removeItem = () => { throw new Error('Storage disabled'); };
    assert.throws(() => deleteTranscript('take-b'), /remover a transcrição/);
    assert.throws(() => saveTranscript('invalid', { ...transcript, cues: [] }), /dados inválidos/);
  } finally {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else delete globalThis.localStorage;
  }
});
