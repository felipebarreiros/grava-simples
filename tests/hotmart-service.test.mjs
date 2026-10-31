import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createHotmartService } from '../server/hotmart/service.ts';
import { HotmartUpload, HOTMART_PART_SIZE } from '../server/hotmart/upload.ts';
import { HotmartError, HotmartCoursePendingError } from '../server/hotmart/types.ts';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const pid = '12345';
const fixedNow = Date.UTC(2026, 9, 31, 4, 5, 6);
const sha = text => createHash('sha256').update(text).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const awsSecret = 'fixture-upload-secret';
function signAws(stringToSign) {
  const scope = stringToSign.split('\n')[2].split('/');
  const dateKey = hmac(`AWS4${awsSecret}`, scope[0]);
  const regionKey = hmac(dateKey, scope[1]);
  const serviceKey = hmac(regionKey, scope[2]);
  const signingKey = hmac(serviceKey, 'aws4_request');
  return hmac(signingKey, stringToSign).toString('hex');
}

test('course context sends product header and distinguishes class hashes from product IDs', async () => {
  const calls = [];
  const service = createHotmartService('fixture-token', { fetch: async (url, init) => {
    const u = new URL(url); calls.push({ u, headers: new Headers(init.headers) });
    if (u.pathname.includes('/memberships/products/')) return json({ slug: 'creator-area' });
    if (u.pathname.endsWith('/basic')) return json({ id: 12345, name: 'Course', clubSubdomain: 'course-subdomain' });
    if (u.pathname.endsWith('/membershipClass')) return json([{ hashId: 'defaultclass', name: 'membership.default.class.name', defaultClass: true }]);
    if (u.pathname.endsWith('/modules') && u.searchParams.get('extra') === 'false') return json([{ id: 'module1', name: 'First', order: 1 }]);
    if (u.pathname.endsWith('/modules')) return json([]);
    if (u.pathname.endsWith('/pages')) return json([{ id: 'lesson1', name: 'Intro', pageOrder: 1, published: false }]);
    throw new Error(`Unexpected URL ${u}`);
  } });
  const detail = await service.getCourse(pid);
  assert.equal(detail.course.membershipSlug, 'creator-area');
  assert.equal(detail.course.subdomain, 'course-subdomain');
  assert.equal(detail.classes[0].id, 'defaultclass');
  assert.equal(detail.classes[0].name, 'Turma padrão');
  assert.equal(detail.modules[0].lessons[0].title, 'Intro');
  const classCall = calls.find(call => call.u.pathname.endsWith('/membershipClass'));
  assert.equal(classCall.u.search, '');
  for (const call of calls.filter(call => call.u.hostname === 'api-club-content.cb.hotmart.com')) {
    assert.equal(call.headers.get('x-product-id'), pid);
    assert.equal(call.headers.get('Authorization'), 'Bearer fixture-token');
  }
});

test('module creation uses an existing default class and private restricted module settings', async () => {
  const calls = [];
  const service = createHotmartService('fixture-token', { fetch: async (url, init) => {
    if (new URL(url).pathname.endsWith('/membershipClass')) return json([{ hashId: 'class1', defaultClass: true }]);
    calls.push(JSON.parse(init.body));
    return json({ id: 'newmodule', order: 3 });
  } });
  const result = await service.createModule(pid, { name: '  New module  ' });
  assert.equal(result.id, 'newmodule');
  assert.equal(result.name, 'New module');
  assert.deepEqual(calls[0].classes, ['class1']);
  assert.equal(calls[0].publicModule, false);
  assert.equal(calls[0].paidModule, false);
});

test('lesson attachment uses file ID, escapes user text, and never publishes implicitly', async () => {
  const calls = [];
  const service = createHotmartService('fixture-token', { fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), method: init.method });
    return json({ id: 'page1' });
  } });
  const created = await service.createLesson(pid, { moduleId: 'module1', title: 'Intro', description: '<script>alert(1)</script>\nNext line', fileId: 'file123' });
  assert.equal(created.published, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.mediaIdList, ['file123']);
  assert.match(calls[0].body.page.content, /&lt;script&gt;/);
  assert.doesNotMatch(calls[0].body.page.content, /<script>/);
  await service.publishLesson(pid, created.id);
  assert.equal(calls[1].method, 'PUT');
  assert.match(calls[1].url, /\/pages\/published$/);
  assert.deepEqual(calls[1].body, { modules: null, published: true, notifyEmail: false, pages: ['page1'] });
});

test('provider errors are sanitized and expired sessions have a reconnect code', async () => {
  const service = createHotmartService('fixture-token', { fetch: async () => new Response('private token and provider internals', { status: 401 }) });
  await assert.rejects(service.listCourses(), error => error instanceof HotmartError && error.code === 'hotmart_expired' && !error.message.includes('private'));
});

test('course creation checks pricing and uses stable ucode; delayed product result is resolved without another POST', async () => {
  const calls = [];
  const ucode = '7e0d1111-2222-4333-8444-555555555555';
  let productReads = 0;
  const service = createHotmartService('fixture-token', { sleep: async () => {}, fetch: async (url, init) => {
    const u = new URL(url); calls.push({ u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (u.pathname.endsWith('/memberships/owner')) return json({ content: [{ id: 'area1', name: 'Area', slug: 'creator' }] });
    if (u.pathname.endsWith('/payment-mode')) return json({ paymentModes: ['PAY_IN_FULL'], minimumCreditCardAmount: 3 });
    if (u.pathname === '/product/v1/product') return new Response(null, { status: 202 });
    if (u.pathname.includes('/ucode/')) return ++productReads < 2 ? json({}, 404) : json({ id: 12345, name: 'Course', ucode, status: 'DRAFT' });
    if (u.pathname.includes('/memberships/products/')) return json({}, 404);
    if (u.pathname.includes('/new-clubs/')) return new Response(null, { status: 204 });
    throw new Error(`Unexpected URL ${u}`);
  } });
  const result = await service.createCourse({ name: 'Course', description: 'A'.repeat(200), locale: 'pt_BR', price: 99, currency: 'BRL', membershipSlug: 'creator' }, ucode);
  assert.equal(result.id, pid);
  const creates = calls.filter(call => call.method === 'POST');
  assert.equal(creates.length, 1);
  assert.equal(creates[0].body.productDetail.ucode, ucode);
  assert.equal(creates[0].body.productDetail.format.id, 1);
  assert.equal(creates[0].body.productDetail.targetCountry, 1);
  assert.equal(creates[0].body.productDetail.category, 18);
  assert.equal(creates[0].body.productDetail.contentLocale, 'PT_BR');
  assert.equal(creates[0].body.productDetail.coverPhoto, null);
  assert.equal(creates[0].body.offerPayment.paymentMode, 'PAY_IN_FULL');
  assert.equal(productReads, 2);
});

test('course listing distinguishes legacy ebook format 1 from creation-course format 1', async () => {
  const service = createHotmartService('fixture-token', { fetch: async () => json({ data: [
    { id: 1, name: 'Ebook', format: 1, labelFormat: 'category.ebook.name' },
    { id: 8, name: 'Course', format: 8, labelFormat: 'category.membership.name' },
    { id: 12, name: 'Event', format: 12 },
  ] }) });
  assert.deepEqual((await service.listCourses()).map(item => item.name), ['Course', 'Event']);
});

test('thumbnail readiness does not report video readiness before transcoding completes', async () => {
  const service = createHotmartService('fixture-token', { fetch: async () => json({ code: 'media1', status: 'THUMBNAIL_READY' }) });
  assert.equal((await service.getMediaStatus(pid, 'media1')).status, 'processing');
});

test('module rename/reorder follow the production anchor-and-previous-ID DTO', async () => {
  const calls = [];
  const service = createHotmartService('fixture-token', { fetch: async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/modules')) return json(u.searchParams.get('extra') === 'true' ? [{ id: 'extra', name: 'Extra', order: 4 }] : [
      { id: 'a', name: 'A', order: 1 }, { id: 'b', name: 'B', order: 2 }, { id: 'c', name: 'C', order: 3 },
    ]);
    calls.push({ path: u.pathname, method: init.method, body: JSON.parse(init.body) });
    return json({});
  } });
  await service.renameModule(pid, 'a', 'Renamed');
  assert.deepEqual(calls[0], { path: '/v4/modules/a/name', method: 'PUT', body: { name: 'Renamed' } });
  await service.reorderModules(pid, ['c', 'b', 'a']);
  assert.deepEqual(calls[1], { path: '/v4/modules/c/order', method: 'POST', body: { targetModuleOrderId: 'a', positionType: 'FIRST', newPreviousModuleId: null } });
  assert.deepEqual(calls[2], { path: '/v4/modules/b/order', method: 'POST', body: { targetModuleOrderId: 'a', positionType: 'AFTER_TARGET', newPreviousModuleId: 'c' } });
  assert.equal(calls.length, 3);
});

test('pending course carries recoverable identity and re-resolution skips an existing membership attachment', async () => {
  const ucode = '7e0d1111-2222-4333-8444-555555555555';
  const pending = createHotmartService('fixture-token', { sleep: async () => {}, fetch: async () => json({}, 404) });
  await assert.rejects(pending.resolveCourseCreation(ucode, 'creator'), error => error instanceof HotmartCoursePendingError && error.ucode === ucode && error.membershipSlug === 'creator');
  const calls = [];
  const ready = createHotmartService('fixture-token', { fetch: async (url, init) => {
    calls.push(init.method ?? 'GET');
    return json(url.includes('/ucode/') ? { id: 12345, name: 'Course' } : { slug: 'creator' });
  } });
  await ready.resolveCourseCreation(ucode, 'creator');
  assert.deepEqual(calls, ['GET', 'GET']);
});

const uploadConfig = {
  aws_key: 'AKIAABCDEFGHIJKLMNOP', bucket: 'hot-upload-production', byteSizeLimit: 20 * 1024 ** 3,
  supportedFiles: ['video/mp4'], shouldSendFinishEvent: true,
  paths: {
    startURL: 'https://api-gateway.play.hotmart.com/v2/media/upload',
    signerURL: 'https://api-club-upload.cb.hotmart.com/v5/upload/sign',
    finishURL: 'https://api-club-upload.cb.hotmart.com/v5/upload/finish',
  },
};
function uploadFixture() {
  const calls = [];
  const fetch = async (url, init) => {
    const u = new URL(url); calls.push({ u, init, headers: new Headers(init.headers) });
    if (u.pathname.endsWith('/upload/config')) return json(uploadConfig);
    if (u.pathname.endsWith('/media/upload')) return json({ id: 'file123', mediaCode: 'media123', objectKey: 'courses/lesson video.mp4' });
    if (u.pathname.endsWith('/upload/sign')) return new Response(signAws(u.searchParams.get('to_sign')));
    if (u.hostname.endsWith('amazonaws.com') && u.searchParams.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>opaque+upload/id=</UploadId></InitiateMultipartUploadResult>');
    if (u.hostname.endsWith('amazonaws.com')) return new Response('<CompleteMultipartUploadResult><ETag>complete</ETag></CompleteMultipartUploadResult>');
    if (u.pathname.endsWith('/upload/finish')) return json({});
    if (u.pathname.endsWith('/folder/delete')) return json({});
    throw new Error(`Unexpected URL ${u}`);
  };
  return { calls, upload: new HotmartUpload('fixture-session-secret', { fetch, now: () => fixedNow }) };
}

test('upload initialization keeps video bytes out of API calls and defaults to private PAGE_MEDIA', async () => {
  const { calls, upload } = uploadFixture();
  const state = await upload.start({ productId: pid, subdomain: 'course1' }, { fileName: 'lesson.mp4', size: HOTMART_PART_SIZE + 10, mimeType: 'video/mp4' });
  assert.equal(state.fileId, 'file123');
  assert.equal(state.mediaCode, 'media123');
  assert.equal(state.uploadId, 'opaque+upload/id=');
  const start = calls.find(call => call.u.pathname.endsWith('/media/upload'));
  assert.deepEqual(JSON.parse(start.init.body).metaData, { subdomain: 'course1', isPublic: false, type: 'PAGE_MEDIA' });
  const s3 = calls.find(call => call.u.hostname.endsWith('amazonaws.com'));
  assert.match(s3.headers.get('Authorization'), /^AWS4-HMAC-SHA256 /);
  assert.ok(!s3.headers.get('Authorization').includes('fixture-session-secret'));
  assert.equal(s3.init.body, undefined);
});

test('part URLs are valid presigned SigV4 queries bound to exact object, multipart id and part number', async () => {
  const { calls, upload } = uploadFixture();
  const state = await upload.start({ productId: pid, subdomain: 'course1' }, { fileName: 'lesson.mp4', size: HOTMART_PART_SIZE + 10, mimeType: 'video/mp4' });
  const part = await upload.signPart(state, 2);
  const u = new URL(part.url);
  assert.equal(u.pathname, '/courses/lesson%20video.mp4');
  assert.equal(u.searchParams.get('uploadId'), 'opaque+upload/id=');
  assert.equal(u.searchParams.get('partNumber'), '2');
  assert.equal(u.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'content-length;host');
  assert.deepEqual(part.headers, {});
  assert.equal(part.expiresAt, fixedNow + 900000);
  const canonicalQuery = [...u.searchParams.entries()].filter(([key]) => key !== 'X-Amz-Signature').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
  const canonical = ['PUT', u.pathname, canonicalQuery, `content-length:10\nhost:${u.host}\n`, 'content-length;host', 'UNSIGNED-PAYLOAD'].join('\n');
  const signer = calls.filter(call => call.u.pathname.endsWith('/upload/sign')).at(-1);
  const stringToSign = signer.u.searchParams.get('to_sign');
  assert.equal(stringToSign.split('\n').at(-1), sha(canonical));
  assert.equal(u.searchParams.get('X-Amz-Signature'), signAws(stringToSign));
  assert.ok(!part.url.includes('fixture-session-secret'));
  await assert.rejects(upload.signPart(state, 3), error => error.code === 'invalid_part');
});

test('multipart completion rejects missing/duplicate parts and finish is a separately resumable operation', async () => {
  const { calls, upload } = uploadFixture();
  const state = await upload.start({ productId: pid, subdomain: 'course1' }, { fileName: 'lesson.mp4', size: HOTMART_PART_SIZE + 10, mimeType: 'video/mp4' });
  const etag = 'a'.repeat(32);
  await assert.rejects(upload.completeParts(state, [{ partNumber: 1, etag }]), error => error.code === 'incomplete_upload');
  await assert.rejects(upload.completeParts(state, [{ partNumber: 1, etag }, { partNumber: 1, etag }]), error => error.code === 'invalid_parts');
  await upload.completeParts(state, [{ partNumber: 2, etag }, { partNumber: 1, etag }]);
  assert.equal(calls.filter(call => call.u.pathname.endsWith('/upload/finish')).length, 0);
  const complete = calls.filter(call => call.u.hostname.endsWith('amazonaws.com')).at(-1);
  assert.match(complete.init.body, /<PartNumber>1<\/PartNumber>.*<PartNumber>2<\/PartNumber>/);
  await upload.finish(state);
  const finish = calls.find(call => call.u.pathname.endsWith('/upload/finish'));
  assert.deepEqual(JSON.parse(finish.init.body), { id: 'file123', sendFinishEvent: true });
});

test('changed upload config and forged S3 state cannot redirect session credentials or signing', async () => {
  const upload = new HotmartUpload('fixture-secret', { fetch: async () => json({ ...uploadConfig, paths: { ...uploadConfig.paths, signerURL: 'https://evil.test/sign' } }) });
  await assert.rejects(upload.start({ productId: pid, subdomain: 'course1' }, { fileName: 'video.mp4', size: 100, mimeType: 'video/mp4' }), error => error.code === 'upload_configuration_changed');
  const valid = uploadFixture();
  const state = await valid.upload.start({ productId: pid, subdomain: 'course1' }, { fileName: 'video.mp4', size: 100, mimeType: 'video/mp4' });
  await assert.rejects(valid.upload.signPart({ ...state, bucket: 'evil.test/path' }, 1), error => error.code === 'invalid_upload');
  await assert.rejects(valid.upload.signPart({ ...state, objectKey: '../other' }, 1), error => error.code === 'invalid_upload');
});

test('cancel aborts multipart transfer and removes only the media entry reserved for that upload', async () => {
  const { calls, upload } = uploadFixture();
  const state = await upload.start({ productId: pid, subdomain: 'course1' }, { fileName: 'lesson.mp4', size: 100, mimeType: 'video/mp4' });
  await upload.abort(state);
  const s3Abort = calls.find(call => call.init.method === 'DELETE');
  assert.equal(s3Abort.u.searchParams.get('uploadId'), 'opaque+upload/id=');
  const cleanup = calls.find(call => call.u.pathname.endsWith('/folder/delete'));
  assert.deepEqual(JSON.parse(cleanup.init.body), { codes: ['media123'] });
});

test('successful writes with malformed provider IDs are upstream failures, never retryable input errors', async () => {
  for (const operation of ['membership', 'module', 'lesson']) {
    let writes = 0;
    const service = createHotmartService('fixture-token', { fetch: async (url, init) => {
      if ((init.method ?? 'GET') === 'GET') return json([{ hashId: 'class1', defaultClass: true }]);
      writes++;
      return json({}, 201);
    } });
    const work = operation === 'membership'
      ? service.createMembership({ name: 'Area', slug: 'creator' })
      : operation === 'module'
        ? service.createModule(pid, { name: 'Module' })
        : service.createLesson(pid, { moduleId: 'module1', title: 'Lesson', description: '', fileId: 'file123' });
    await assert.rejects(work, error => error.status === 502 && error.code === 'invalid_provider_response');
    assert.equal(writes, 1);
  }
});

test('malformed list responses and returned course/class IDs are provider contract failures', async () => {
  const cases = [
    { method: 'listCourses', response: { items: [] } },
    { method: 'listCourses', response: { data: [{ id: 'not-a-product-id', name: 'Course', format: 8 }] } },
    { method: 'listMemberships', response: { content: [{ name: 'Area', slug: 'creator' }] } },
    { method: 'listClasses', response: [{ name: 'Class', hashId: 'invalid/id' }], argument: pid },
    { method: 'listModules', response: { unexpected: [] }, argument: pid },
  ];
  for (const fixture of cases) {
    const service = createHotmartService('fixture-token', { fetch: async () => json(fixture.response) });
    await assert.rejects(service[fixture.method](fixture.argument), error => error.status === 502 && error.code === 'invalid_provider_response');
  }
});

test('malformed upload initialization IDs cannot make the frontend reset its mutation receipt', async () => {
  let writes = 0;
  const upload = new HotmartUpload('fixture-token', { fetch: async (url, init) => {
    if ((init.method ?? 'GET') === 'GET') return json(uploadConfig);
    writes++;
    return json({ objectKey: 'file1/video.mp4', id: 'file1' }, 201);
  } });
  await assert.rejects(upload.start({ productId: pid, subdomain: 'course1' }, { fileName: 'video.mp4', size: 100, mimeType: 'video/mp4' }), error => error.status === 502 && error.code === 'invalid_provider_response');
  assert.equal(writes, 1);
});
