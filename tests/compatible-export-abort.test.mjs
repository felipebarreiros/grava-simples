import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { registerHooks } from 'node:module';
import { prepareCompatibleDownload } from '../src/media/compatibleExport.ts';

const file = () => ({
  orientation: 'landscape', blob: new Blob(['video'], { type: 'video/mp4' }),
  url: 'blob:original', fileName: 'lesson.mp4', mimeType: 'video/mp4', size: 5, durationMs: 1000,
});

test('cancelled export rejects with AbortError before media validation or worker loading', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Caller interrupted'));
  let progress = 0;
  await assert.rejects(
    prepareCompatibleDownload({ ...file(), mimeType: 'video/webm' }, () => progress++, controller.signal),
    error => error.name === 'AbortError',
  );
  assert.equal(progress, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('queued cancellation prevents worker work and does not poison the following export', async () => {
  const first = prepareCompatibleDownload({ ...file(), mimeType: 'video/webm' }).catch(() => undefined);
  const controller = new AbortController();
  let progress = 0;
  const queued = prepareCompatibleDownload(file(), () => progress++, controller.signal);
  controller.abort();
  await assert.rejects(queued, error => error.name === 'AbortError');
  await first;
  await assert.rejects(prepareCompatibleDownload({ ...file(), mimeType: 'video/webm' }), /WebM/);
  assert.equal(progress, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('abort at preparation start stops before importing FFmpeg and removes cancellation listeners', async () => {
  const controller = new AbortController();
  const phases = [];
  await assert.rejects(prepareCompatibleDownload(file(), next => {
    phases.push(next.phase);
    controller.abort();
  }, controller.signal), error => error.name === 'AbortError');
  // Allow the conversion's finally handler to release its listener after the
  // caller has already received the interruption.
  await Promise.resolve();
  assert.deepEqual(phases, ['loading']);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('interrupting an active worker terminates it once and retains the original recording', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const original = file();
  const controller = new AbortController();
  let started;
  const loading = new Promise(resolve => { started = resolve; });
  const worker = { terminated: 0, started, reject: null };
  globalThis.__exportAbortWorker = worker;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://studio.test' } } });
  const source = `export class FFmpeg {
    on() {}
    load() { globalThis.__exportAbortWorker.started(); return new Promise((_, reject) => { globalThis.__exportAbortWorker.reject = reject; }); }
    terminate() { globalThis.__exportAbortWorker.terminated++; globalThis.__exportAbortWorker.reject('terminated'); }
  }`;
  const stub = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === '@ffmpeg/ffmpeg' ? { url: stub, shortCircuit: true } : next(specifier, context);
  } });
  try {
    const pending = prepareCompatibleDownload(original, undefined, controller.signal);
    await loading;
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(worker.terminated, 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(original.url, 'blob:original');
    assert.equal(await original.blob.text(), 'video');
  } finally {
    hooks.deregister();
    delete globalThis.__exportAbortWorker;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else delete globalThis.window;
  }
});
