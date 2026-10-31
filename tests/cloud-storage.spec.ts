import { test, expect } from './fixtures/auth';
import { readFileSync } from 'node:fs';
import { seedRecordingReview } from './fixtures/recordings';

const media = readFileSync('.context/recording-detail-fixture.mp4');
const id = 'a0000000-0000-4000-8000-000000000001';
const localId = 'recording-cloud-fixture';
const remote = {
  id, localId, projectId: 'project-cloud-fixture', projectName: 'Projeto na nuvem', name: 'Minha gravação na nuvem',
  createdAt: 1_700_000_000_000, startedAt: 1_700_000_000_000, stoppedAt: 1_700_000_008_000, durationMs: 8000,
  warnings: [], status: 'ready', landscape: { fileName: 'horizontal.mp4', mimeType: 'video/mp4', size: media.length }, portrait: { fileName: 'vertical.mp4', mimeType: 'video/mp4', size: media.length },
};
const transcript = { version: 1, sourceName: 'Transcrição', importedAt: 1, updatedAt: 2, origin: 'automatic', provider: 'assemblyai', cues: [{ id: 'cue-1', start: 0, end: 2, text: 'Uma ideia guardada na nuvem.' }] };

test('a fresh browser opens a cloud recording, restores transcript and keeps video streaming without an offline cache', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const savedVersions: any[] = [];
  await page.route('**/api/recordings*', async route => {
    const request = route.request();
    expect(request.headers().authorization).toBe('Bearer fixture-session-token');
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      const body = request.postDataJSON(); savedVersions.push(body);
      return route.fulfill({ json: { version: 2 } });
    }
    if (url.searchParams.get('transcript')) return route.fulfill({ json: { transcript, version: 1 } });
    if (url.searchParams.get('orientation')) return route.fulfill({ json: { url: `https://fixture.private.blob.vercel-storage.com/${url.searchParams.get('orientation')}.mp4?signature=private-test`, expiresAt: Date.now() + 600_000 } });
    return route.fulfill({ json: { configured: true, recordings: [remote], nextCursor: null, usedBytes: media.length * 2, maxStorageBytes: 10 * 1024 ** 3 } });
  });
  await page.route('https://fixture.private.blob.vercel-storage.com/**', route => route.fulfill({ contentType: 'video/mp4', body: media, headers: { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Accept-Ranges': 'bytes' } }));
  await page.goto(`/app?test=1#project/${remote.projectId}/recording/${localId}`);
  await expect(page.getByTestId('recording-detail')).toBeVisible();
  await expect(page.getByTestId('recording-video-landscape')).toHaveAttribute('src', /fixture\.private\.blob/);
  await expect.poll(() => page.getByTestId('recording-video-landscape').evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('transcript-cue')).toContainText('Uma ideia guardada na nuvem.');
  await expect(page.getByTestId('recording-detail').getByTestId(`cloud-actions-${localId}`)).toContainText('Na nuvem');
  const cached = await page.evaluate(async () => {
    const storage = await import('/src/media/storage.ts');
    return storage.listRecoverableRecordings();
  });
  expect(cached).toHaveLength(0);
  await page.getByRole('button', { name: 'Corrigir trecho em 00:00' }).click();
  await page.getByRole('textbox', { name: 'Corrigir texto do trecho' }).fill('Minha correção preservada.');
  await page.getByRole('button', { name: 'Salvar correção', exact: true }).click();
  await page.getByRole('button', { name: 'Salvar transcrição na nuvem' }).click();
  await expect.poll(() => savedVersions.length).toBe(1);
  expect(savedVersions[0]).toMatchObject({ action: 'transcript', recordingId: id, expectedVersion: 1, transcript: { cues: [{ text: 'Minha correção preservada.' }] } });
  await expect(page.locator('.cloud-transcript-sync')).toContainText('Transcrição salva na nuvem.');
  expect(errors).toEqual([]);
});

test('local originals are uploaded only on request and confirmed backup permits removing the offline copy', async ({ page }) => {
  const saved = await seedRecordingReview(page);
  let ready = false;
  let reserved: any;
  const uploaded: string[] = [];
  // Provider transport only: the browser still reads real persisted MediaRecorder fixture bytes.
  await page.route(/\/@vercel_blob_client\.js(?:\?.*)?$/, route => route.fulfill({ contentType: 'application/javascript', body: `export async function upload(pathname,blob,options){const response=await fetch('/fixture-upload',{method:'POST',body:JSON.stringify({pathname,size:blob.size,type:blob.type,payload:JSON.parse(options.clientPayload),authorization:options.headers.Authorization})});if(!response.ok)throw Error('Upload failed');options.onUploadProgress?.({percentage:100});return {pathname};}` }));
  await page.route('**/fixture-upload', route => { const body = route.request().postDataJSON(); expect(body.authorization).toBe('Bearer fixture-session-token'); expect(body.size).toBe(saved.bytes); uploaded.push(body.payload.orientation); return route.fulfill({ json: {} }); });
  await page.route('**/api/recordings*', route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      if (body.action === 'reserve') { reserved = { ...body.take, id, localId: body.take.id, projectName: body.projectName, status: ready ? 'ready' : 'pending' }; return route.fulfill({ json: { recording: reserved, uploads: { landscape: { pathname: 'recordings/landscape.mp4', uploaded: uploaded.includes('landscape') }, portrait: { pathname: 'recordings/portrait.mp4', uploaded: uploaded.includes('portrait') } } } }); }
      if (body.action === 'finalize') { if (uploaded.length !== 2) return route.fulfill({ status: 409, json: { error: 'Envio incompleto.' } }); ready = true; reserved.status = 'ready'; return route.fulfill({ json: { recording: reserved } }); }
    }
    return route.fulfill({ json: { configured: true, recordings: ready ? [reserved] : [], nextCursor: null, usedBytes: ready ? saved.bytes * 2 : 0, maxStorageBytes: 10 * 1024 ** 3 } });
  });
  await page.goto(`/app?test=1#project/${saved.projectId}`);
  await page.getByRole('tab', { name: /^Gravações/ }).click();
  await expect(page.getByTestId(`cloud-actions-${saved.takeId}`)).toContainText('Somente neste dispositivo');
  expect(uploaded).toEqual([]);
  await page.getByRole('button', { name: 'Salvar na nuvem', exact: true }).click();
  await expect(page.getByTestId(`cloud-actions-${saved.takeId}`)).toContainText('Neste dispositivo + nuvem');
  expect(uploaded).toEqual(['landscape', 'portrait']);
  await page.getByRole('button', { name: 'Liberar cópia local' }).click();
  await expect(page.getByTestId(`cloud-actions-${saved.takeId}`)).toContainText('Na nuvem');
  expect(await page.evaluate(async () => (await import('/src/media/storage.ts')).listRecoverableRecordings())).toHaveLength(0);
});


test('legacy browser recordings require an explicit import and another account receives an empty local workspace', async ({ page }) => {
  const saved = await seedRecordingReview(page);
  await page.evaluate(async ({ takeId }) => {
    const keys = await import('/src/projects/keys.ts');
    const storage = await import('/src/media/storage.ts');
    const original = localStorage.getItem(keys.WORKSPACE_STORAGE_KEY)!;
    const files = await storage.readRecordingFiles(takeId);
    await storage.writeRecordingFiles(takeId, files, null);
    await storage.deleteRecordingFiles(takeId, 'user_fixture');
    localStorage.setItem('grava-simples-workspace-v1', original);
    localStorage.removeItem(keys.WORKSPACE_STORAGE_KEY);
  }, saved);
  const requests: string[] = [];
  await page.route('**/api/recordings*', route => { requests.push(route.request().method()); return route.fulfill({ json: { configured: true, recordings: [], nextCursor: null, usedBytes: 0, maxStorageBytes: 10 * 1024 ** 3 } }); });
  await page.goto('/app');
  await expect(page.getByRole('button', { name: 'Importar minhas gravações deste navegador' })).toBeVisible();
  expect(await page.evaluate(async () => (await import('/src/projects/store.ts')).listProjectTakes().length)).toBe(0);
  await page.getByRole('button', { name: 'Importar minhas gravações deste navegador' }).click();
  await expect(page.getByRole('button', { name: 'Importar minhas gravações deste navegador' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await import('/src/projects/store.ts')).listProjectTakes().length)).toBe(1);
  const result = await page.evaluate(async () => {
    const keys = await import('/src/projects/keys.ts');
    const store = await import('/src/projects/store.ts');
    const storage = await import('/src/media/storage.ts');
    const imported = store.listProjectTakes();
    const importedFiles = await storage.readRecordingFiles(imported[0].id);
    keys.setLocalAccount('user_second');
    const isolated = { takes: store.listProjectTakes().length, legacy: store.hasUnclaimedLegacyRecordings(), recordings: (await storage.listRecoverableRecordings()).length };
    keys.setLocalAccount('user_fixture');
    return { imported: imported.length, bytes: importedFiles.landscape.size, isolated };
  });
  expect(result).toEqual({ imported: 1, bytes: saved.bytes, isolated: { takes: 0, legacy: false, recordings: 0 } });
  expect(requests.every(method => method === 'GET')).toBe(true);
});
