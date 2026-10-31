import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { handleHotmart } from '../server/hotmart/controller.ts';
import { ApiError } from '../server/transcription/security.ts';
import { HotmartError } from '../server/hotmart/types.ts';

const courseId = '123456';
const ownerId = 'user_alice';
const state = { productId: courseId, subdomain: 'fixture-course', fileId: 'file-1', mediaCode: 'media-1', objectKey: 'private/key', bucket: 'private-bucket', awsKey: 'private-aws-key', region: 'us-east-1', uploadId: 'private-upload-id', partSize: 6291456, fileSize: 1024, signerURL: 'https://api-club-upload.cb.hotmart.com/v5/upload/sign', finishURL: 'https://api-club-upload.cb.hotmart.com/v5/upload/finish', shouldSendFinishEvent: true, createdAt: Date.now() };
function req(action, body, headers = {}) {
  return new Request(`https://studio.test/api/hotmart?action=${action}${body?.query || ''}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer fixture', Origin: 'https://studio.test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify({ action, ...body }) } : {}),
  });
}
function fixture() {
  const rows = new Map(), calls = [];
  const key = (owner, operation) => `${owner}:${operation}`;
  const repository = {
    async once(owner, operation, action, input, work) {
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const name = key(owner, operation), prior = rows.get(name);
      if (prior) {
        if (prior.fingerprint !== fingerprint || prior.action !== action || prior.status !== 'done') throw new ApiError(409, 'Operação em andamento ou não confirmada.');
        return structuredClone(prior.value);
      }
      rows.set(name, { action, fingerprint, status: 'pending' });
      try {
        const value = await work(); rows.set(name, { action, fingerprint, status: 'done', value: structuredClone(value) }); return value;
      } catch (error) { rows.get(name).status = 'uncertain'; throw error; }
    },
    async get(owner, operation) { return structuredClone(rows.get(key(owner, operation))?.value || null); },
    async update(owner, operation, value, expectedStatus) {
      const row = rows.get(key(owner, operation));
      if (expectedStatus !== undefined && row.value.status !== expectedStatus) return;
      row.value = structuredClone(value);
    },
  };
  const service = {
    async listCourses() { return [{ id: courseId, name: 'Fixture course' }]; },
    async listMemberships() { return [{ id: 'membership-1', name: 'Fixture', slug: 'fixture' }]; },
    async getCourse() { return { course: { id: courseId, name: 'Fixture', subdomain: 'fixture-course' }, modules: [{ id: 'module-1', name: 'Module', order: 0, lessons: [] }], classes: [] }; },
    async createModule(pid, input) { calls.push(['create-module', pid, input]); return { id: 'module-new', name: input.name, order: 1, lessons: [] }; },
    async listModules() { return [{ id: 'module-1', name: 'Module', order: 0, lessons: [] }]; },
    async renameModule(...args) { calls.push(['rename-module', ...args]); },
    async reorderModules(...args) { calls.push(['reorder-modules', ...args]); },
    async createCourse(input, ucode) { calls.push(['create-course', ucode]); return { id: '234567', name: input.name }; },
    async resolveCourseCreation(ucode, slug) { calls.push(['resolve-course', ucode, slug]); return { id: '234567', name: 'Created' }; },
    async getMediaStatus() { return { status: 'ready', mediaCode: state.mediaCode }; },
    async createLesson(pid, input) { calls.push(['create-lesson', pid, input]); return { id: 'lesson-1', title: input.title, published: false }; },
    async publishLesson(...args) { calls.push(['publish-lesson', ...args]); },
  };
  const upload = {
    async start(context, file) { calls.push(['upload-start', context, file]); return structuredClone(state); },
    async signPart(s, number) { calls.push(['upload-sign', number]); return { url: 'https://fixture.s3.amazonaws.com/part?signature=scoped', headers: {}, expiresAt: Date.now() + 900000 }; },
    async completeParts(...args) { calls.push(['complete-parts', ...args]); },
    async finish(...args) { calls.push(['finish', ...args]); },
    async abort(...args) { calls.push(['abort', ...args]); },
  };
  const deps = {
    env: { APP_ORIGINS: 'https://studio.test', HOTMART_OIDC_REDIRECT_URI: 'https://studio.test/api/hotmart?action=callback' },
    configured: true,
    authenticate: async request => { if (!request.headers.get('Authorization')) throw new ApiError(401, 'Entre na sua conta.'); return { userId: request.headers.get('X-Owner') || ownerId }; },
    auth: {
      begin: () => ({ url: 'https://sso.hotmart.com/oidc/authorize?code_challenge=fixture', cookies: ['oauth=fixture; HttpOnly'] }),
      complete: async () => ({ returnTo: '/app?test=1#project/p/recording/r', ownerId, cookies: ['session=fixture; HttpOnly', 'oauth=; Max-Age=0'] }),
      read: async request => request.headers.get('X-Disconnected') ? null : { session: { token: 'HOTMART-SECRET', hotmartUserId: request.headers.get('X-Hotmart-Owner') || 'owner-123', accountName: 'Fixture Creator', expiresAt: Date.now() + 86400000 } },
      disconnect: () => ['session=; Max-Age=0', 'oauth=; Max-Age=0'],
    },
    repository, service: () => service, uploader: () => upload, now: Date.now,
  };
  const start = async (overrides = {}) => {
    const requestId = randomUUID();
    const body = { requestId, courseId, moduleId: 'module-1', title: 'Lesson title', description: '<script>plain text</script>', publish: false, fileName: 'video.mp4', fileSize: 1024, fileType: 'video/mp4', ...overrides };
    const response = await handleHotmart(req('upload-start', body), deps);
    return { requestId, body, response, result: await response.json() };
  };
  return { deps, rows, calls, service, upload, start };
}

test('Hotmart status is authenticated, configuration is accurate, and responses never expose session credentials', async () => {
  const f = fixture(); f.deps.configured = false;
  const unauthenticated = req('status'); unauthenticated.headers.delete('Authorization');
  assert.equal((await handleHotmart(unauthenticated, f.deps)).status, 401);
  assert.deepEqual(await (await handleHotmart(req('status'), f.deps)).json(), { configured: false, connected: false, message: 'A conexão com a Hotmart ainda não está disponível. Você pode continuar baixando seus vídeos.' });
  f.deps.configured = true;
  const response = await handleHotmart(req('status'), f.deps);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text(); assert.ok(body.includes('Fixture Creator')); assert.ok(!body.includes('HOTMART-SECRET'));
  assert.equal((await handleHotmart(req('courses', undefined, { 'X-Disconnected': '1' }), f.deps)).status, 401);
});

test('mutations reject foreign/missing origins, unsupported methods, malformed JSON and oversized bodies', async () => {
  const f = fixture();
  assert.equal((await handleHotmart(req('connect', {}, { Origin: 'https://evil.test' }), f.deps)).status, 403);
  const missing = req('connect', {}); missing.headers.delete('Origin');
  assert.equal((await handleHotmart(missing, f.deps)).status, 403);
  assert.equal((await handleHotmart(new Request('https://studio.test/api/hotmart', { method: 'DELETE' }), f.deps)).status, 405);
  const malformed = req('connect', {}); malformed.headers.set('Content-Length', '999999');
  assert.equal((await handleHotmart(malformed, f.deps)).status, 413);
  assert.equal((await handleHotmart(new Request('https://studio.test/api/hotmart', { method: 'POST', headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' }, body: '{bad' }), f.deps)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('callback retains the recording destination and separate session/flow cookies without requiring a Clerk bearer', async () => {
  const f = fixture();
  const response = await handleHotmart(new Request('https://studio.test/api/hotmart?action=callback&code=fixture&state=fixture'), f.deps);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), '/app?test=1&hotmart=connected#project/p/recording/r');
  assert.equal(response.headers.getSetCookie().length, 2);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
});

test('upload initialization is deduplicated and returns only an opaque job ID and public progress layout', async () => {
  const f = fixture(); const first = await f.start();
  assert.equal(first.response.status, 200);
  assert.equal(first.result.status, 'uploading'); assert.equal(first.result.partCount, 1);
  const response = await handleHotmart(req('upload-start', first.body), f.deps);
  assert.deepEqual(await response.json(), first.result);
  assert.equal(f.calls.filter(call => call[0] === 'upload-start').length, 1);
  for (const secret of ['objectKey', 'awsKey', 'signerURL', 'private-upload-id', 'HOTMART-SECRET']) assert.ok(!JSON.stringify(first.result).includes(secret));
  assert.equal((await handleHotmart(req('upload-start', { ...first.body, title: 'Changed' }), f.deps)).status, 409);
});

test('a job cannot be signed or queried by another Clerk owner or a different connected Hotmart account', async () => {
  const f = fixture(), started = await f.start();
  for (const headers of [{ 'X-Owner': 'user_bob' }, { 'X-Hotmart-Owner': 'different-hotmart-owner' }]) {
    assert.equal((await handleHotmart(req('upload-sign', { jobId: started.requestId, partNumber: 1 }, headers), f.deps)).status, 404);
  }
  assert.equal(f.calls.filter(call => call[0] === 'upload-sign').length, 0);
});

test('draft flow completes bytes, waits for media, creates the lesson once and never publishes it', async () => {
  const f = fixture(), started = await f.start(); const jobId = started.requestId;
  assert.equal((await handleHotmart(req('lesson-create', { jobId }), f.deps)).status, 409);
  const parts = [{ partNumber: 1, etag: '"0123456789abcdef0123456789abcdef"' }];
  for (let index = 0; index < 2; index++) assert.equal((await handleHotmart(req('upload-complete', { jobId, parts }), f.deps)).status, 200);
  assert.equal(f.calls.filter(call => call[0] === 'complete-parts').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'finish').length, 1);
  const ready = await handleHotmart(new Request(`https://studio.test/api/hotmart?action=upload-status&jobId=${jobId}`, { headers: { Authorization: 'Bearer fixture' } }), f.deps);
  assert.equal((await ready.json()).status, 'ready');
  for (let index = 0; index < 2; index++) {
    const result = await (await handleHotmart(req('lesson-create', { jobId }), f.deps)).json();
    assert.equal(result.published, false); assert.equal(result.lessonId, 'lesson-1');
  }
  assert.equal(f.calls.filter(call => call[0] === 'create-lesson').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'publish-lesson').length, 0);
  assert.equal(f.calls.find(call => call[0] === 'create-lesson')[2].fileId, 'file-1');
});

test('explicit publish follows draft creation, and ambiguous publication never creates another lesson', async () => {
  const f = fixture(), started = await f.start({ publish: true }); const jobId = started.requestId;
  const job = await f.deps.repository.get(ownerId, jobId); job.status = 'ready'; await f.deps.repository.update(ownerId, jobId, job);
  f.service.publishLesson = async () => { f.calls.push(['publish-lesson']); throw new HotmartError(502, 'hotmart_unreachable', 'Resposta não confirmada.'); };
  assert.equal((await handleHotmart(req('lesson-create', { jobId }), f.deps)).status, 502);
  assert.equal((await handleHotmart(req('lesson-create', { jobId }), f.deps)).status, 409);
  assert.equal(f.calls.filter(call => call[0] === 'create-lesson').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'publish-lesson').length, 1);
});

test('pending course creation resolves the same UUID instead of resubmitting the product', async () => {
  const f = fixture(), requestId = randomUUID();
  f.service.createCourse = async () => { f.calls.push(['create-course']); throw new HotmartError(409, 'course_pending', 'Aguarde.'); };
  const input = { name: 'Course', description: 'Description', membershipSlug: 'fixture', locale: 'pt_BR', currency: 'BRL', price: 99 };
  const pending = await (await handleHotmart(req('course-create', { requestId, input }), f.deps)).json();
  assert.equal(pending.pending, true);
  const result = await (await handleHotmart(req('course-resolve', { requestId }), f.deps)).json();
  assert.equal(result.id, '234567');
  assert.equal(f.calls.filter(call => call[0] === 'create-course').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'resolve-course')[1], requestId);
  const switched = await handleHotmart(req('course-resolve', { requestId }, { 'X-Hotmart-Owner': 'another-provider-account' }), f.deps);
  assert.equal(switched.status, 404);
});

test('a slow processing poll cannot overwrite a completed lesson receipt', async () => {
  const f = fixture(), started = await f.start(); const jobId = started.requestId;
  const job = await f.deps.repository.get(ownerId, jobId); job.status = 'processing'; await f.deps.repository.update(ownerId, jobId, job);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.service.getMediaStatus = async () => { entered(); await new Promise(resolve => { release = resolve; }); return { status: 'ready' }; };
  const poll = handleHotmart(new Request(`https://studio.test/api/hotmart?action=upload-status&jobId=${jobId}`, { headers: { Authorization: 'Bearer fixture' } }), f.deps);
  await waiting;
  job.status = 'ready'; await f.deps.repository.update(ownerId, jobId, job);
  assert.equal((await handleHotmart(req('lesson-create', { jobId }), f.deps)).status, 200);
  release();
  const result = await (await poll).json();
  assert.equal(result.status, 'completed'); assert.equal(result.result.lessonId, 'lesson-1');
});

test('a malformed callback setting still redirects locally instead of leaking a server exception', async () => {
  const f = fixture(); f.deps.env.HOTMART_OIDC_REDIRECT_URI = 'not a url';
  f.deps.auth.complete = async () => { throw new Error('bad configuration'); };
  const response = await handleHotmart(new Request('https://studio.test/api/hotmart?action=callback&code=x&state=y'), f.deps);
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/app?hotmart=error');
});
