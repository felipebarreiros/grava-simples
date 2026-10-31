import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHotmartModule, createHotmartCourse, publishHotmartVideo, HotmartRequestError } from '../src/hotmart/client.ts';

const clerkToken = owner => `header.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.signature`;
function browserFixture() {
  const descriptors = new Map(['location', 'sessionStorage', 'XMLHttpRequest'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const previousFetch = globalThis.fetch;
  const values = new Map();
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'https://studio.test', pathname: '/app', search: '', hash: '' } });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } });
  return { values, restore() { globalThis.fetch = previousFetch; for (const [name, previous] of descriptors) { if (previous) Object.defineProperty(globalThis, name, previous); else delete globalThis[name]; } } };
}
const file = (content, name = 'lesson.mp4') => ({ blob: new Blob([content], { type: 'video/mp4' }), fileName: name, size: content.length, mimeType: 'video/mp4', orientation: 'landscape', durationMs: 1000, url: 'blob:fixture' });
const input = content => ({ file: file(content), recordingId: randomUUID(), courseId: '12345', moduleId: 'module-1', title: 'Lesson', description: '', publish: false });

test('ambiguous structural retries reuse the same operation, while success permits a deliberate new write', async () => {
  const browser = browserFixture();
  const owner = `user_${randomUUID().replaceAll('-', '')}`, calls = [];
  let failure = true;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    if (failure) return Response.json({ error: 'Unconfirmed upstream write', code: 'hotmart_unreachable' }, { status: 502 });
    return Response.json({ id: 'module-1', name: 'Module', order: 0, lessons: [] });
  };
  try {
    const token = async () => clerkToken(owner);
    await assert.rejects(createHotmartModule('12345', { name: 'Module' }, token), error => error instanceof HotmartRequestError && error.status === 502);
    failure = false;
    await createHotmartModule('12345', { name: 'Module' }, token);
    assert.equal(calls[0].requestId, calls[1].requestId);
    await createHotmartModule('12345', { name: 'Module' }, token);
    assert.notEqual(calls[1].requestId, calls[2].requestId);
    assert.equal([...browser.values.keys()].some(key => key.startsWith('grava-hotmart-mutation-')), false);
  } finally { browser.restore(); }
});

test('pending structural receipts are isolated by account and duplicate simultaneous calls share one request', async () => {
  const browser = browserFixture(), calls = [];
  const ownerA = `user_${randomUUID().replaceAll('-', '')}`, ownerB = `user_${randomUUID().replaceAll('-', '')}`;
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); await new Promise(resolve => setTimeout(resolve, 5)); return Response.json({ error: 'Ambiguous', code: 'hotmart_unreachable' }, { status: 502 }); };
  try {
    await Promise.allSettled([createHotmartModule('12345', { name: 'Module' }, async () => clerkToken(ownerA)), createHotmartModule('12345', { name: 'Module' }, async () => clerkToken(ownerA))]);
    assert.equal(calls.length, 1);
    await assert.rejects(createHotmartModule('12345', { name: 'Module' }, async () => clerkToken(ownerB)));
    assert.notEqual(calls[0].requestId, calls[1].requestId);
  } finally { browser.restore(); }
});

test('only known pre-write validation resets a failed structural receipt', async () => {
  const browser = browserFixture(), calls = [];
  const owner = `user_${randomUUID().replaceAll('-', '')}`;
  let code = 'invalid_input';
  globalThis.fetch = async (_url, options) => { calls.push(JSON.parse(options.body)); return Response.json({ error: 'Validation', code }, { status: 422 }); };
  try {
    const token = async () => clerkToken(owner);
    await assert.rejects(createHotmartModule('12345', { name: 'Module' }, token));
    code = 'hotmart_rejected';
    await assert.rejects(createHotmartModule('12345', { name: 'Module' }, token));
    await assert.rejects(createHotmartModule('12345', { name: 'Module' }, token));
    assert.notEqual(calls[0].requestId, calls[1].requestId);
    assert.equal(calls[1].requestId, calls[2].requestId);
  } finally { browser.restore(); }
});

test('asynchronous course creation resolves its original operation without resubmitting creation', async () => {
  const browser = browserFixture(), calls = [];
  const owner = `user_${randomUUID().replaceAll('-', '')}`;
  const originalTimeout = globalThis.setTimeout;
  // Only shorten the client's ordinary poll wait; AbortSignal.timeout uses Node timers internally.
  globalThis.setTimeout = (callback, milliseconds, ...args) => originalTimeout(callback, milliseconds === 3000 ? 1 : milliseconds, ...args);
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return Response.json(body.action === 'course-create' ? { pending: true, requestId: body.requestId } : { id: '777', name: 'New course' });
  };
  try {
    const result = await createHotmartCourse({ name: 'New course', description: 'Description', locale: 'pt_BR', currency: 'BRL', price: 99, membershipSlug: 'school' }, async () => clerkToken(owner));
    assert.equal(result.id, '777');
    assert.deepEqual(calls.map(item => item.action), ['course-create', 'course-resolve']);
    assert.equal(calls[0].requestId, calls[1].requestId);
  } finally { globalThis.setTimeout = originalTimeout; browser.restore(); }
});

test('upload receipts hash actual video content, so same-size edited bytes cannot resume a different video', async () => {
  const browser = browserFixture(), starts = [];
  const owner = `user_${randomUUID().replaceAll('-', '')}`, source = input('AAAA');
  globalThis.fetch = async (url, options) => {
    const action = new URL(url).searchParams.get('action');
    assert.equal(action, 'upload-start');
    starts.push(JSON.parse(options.body));
    return Response.json({ status: 'completed', result: { lessonId: 'page-1', published: false, url: 'https://app.hotmart.com/' } });
  };
  try {
    const token = async () => clerkToken(owner);
    await publishHotmartVideo(source, token);
    await publishHotmartVideo({ ...source, file: file('BBBB') }, token);
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].requestId, starts[1].requestId);
  } finally { browser.restore(); }
});

test('a failed transfer aborts and settles its sibling before exposing a retry', async () => {
  const browser = browserFixture();
  const owner = `user_${randomUUID().replaceAll('-', '')}`, source = input('AB');
  let siblingStartedResolve;
  const siblingStarted = new Promise(resolve => { siblingStartedResolve = resolve; });
  let siblingAborted = false, siblingFinished = false;
  class FakeXHR {
    upload = {};
    status = 200;
    open(_method, url) { this.url = url; }
    setRequestHeader() {}
    getResponseHeader() { return '"etag"'; }
    send() { siblingStartedResolve(); }
    abort() { siblingAborted = true; setTimeout(() => { siblingFinished = true; this.onabort(); }, 5); }
  }
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: FakeXHR });
  globalThis.fetch = async (url, options) => {
    const action = new URL(url).searchParams.get('action');
    if (action === 'upload-start') return Response.json({ jobId: randomUUID(), status: 'uploading', partSize: 1, partCount: 2 });
    if (action === 'upload-sign') {
      const { partNumber } = JSON.parse(options.body);
      if (partNumber === 1) { await siblingStarted; return Response.json({ error: 'Rejected', code: 'hotmart_forbidden' }, { status: 403 }); }
      return Response.json({ url: 'https://s3.test/part2', headers: {} });
    }
    assert.fail(`Unexpected action ${action}`);
  };
  try {
    await assert.rejects(publishHotmartVideo(source, async () => clerkToken(owner)), error => error instanceof HotmartRequestError && error.status === 403);
    assert.equal(siblingAborted, true);
    assert.equal(siblingFinished, true, 'promise rejects only after sibling has settled');
  } finally { browser.restore(); }
});
