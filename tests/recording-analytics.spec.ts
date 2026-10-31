import { gunzipSync } from 'node:zlib';
import { test, expect, type Page } from './fixtures/auth';
import { seedRecordingReview, openRecordingLibrary, openRecordingDetail } from './fixtures/recordings';

test.skip(process.env.ANALYTICS_TEST_ENABLED !== 'true', 'Requires a dedicated Vite server with fake PostHog credentials.');

type CapturedEvent = { event: string; properties: Record<string, any> };

async function analytics(page: Page) {
  const events: CapturedEvent[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' });
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({ brands: [{ brand: 'Google Chrome', version: '145' }], mobile: false, platform: 'Linux', getHighEntropyValues: async () => ({ platform: 'Linux', architecture: 'x86', bitness: '64', uaFullVersion: '145.0.0.0' }) }) });
  });
  await page.route('https://posthog.test/**', async route => {
    const request = route.request();
    if (request.method() === 'POST' && !new URL(request.url()).pathname.startsWith('/flags')) {
      let bytes = request.postDataBuffer();
      if (bytes?.length) {
        if (bytes[0] === 31 && bytes[1] === 139) bytes = gunzipSync(bytes);
        const source = bytes.toString('utf8');
        let payload: any;
        try { payload = JSON.parse(source); }
        catch {
          const data = new URLSearchParams(source).get('data');
          if (!data) throw new Error('Unsupported analytics transport');
          payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
        }
        for (const event of Array.isArray(payload) ? payload : payload.batch ?? [payload]) if (event?.event) events.push(event);
      }
    }
    await route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({
      status: 1, featureFlags: {}, featureFlagPayloads: {}, supportedCompression: ['gzip'], surveys: [],
      sessionRecording: false, capturePerformance: false, errorTracking: { autocaptureExceptions: true }, logs: { captureConsoleLogs: false },
    }) });
  });
  await page.route(/https:\/\/[^/]*posthog\.com\//, route => route.abort());
  return events;
}

async function seedProject(page: Page) {
  await page.route('**/recording-analytics-project-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Fixture</body></html>' }));
  await page.goto('/recording-analytics-project-fixture');
  return page.evaluate(async () => {
    localStorage.clear();
    const store = await import('/src/projects/store.ts');
    const project = store.loadProjects()[0];
    project.name = 'PRIVATE_ANALYTICS_PROJECT';
    project.settings.resolution = '360';
    project.settings.fps = 30;
    store.saveProject(project);
    return project.id;
  });
}

async function flushAnalytics(page: Page) {
  await page.evaluate(async () => { await (await (await import('/src/analytics/client.ts')).initializeAnalytics())?.shutdown(); });
}

test('real capture, persistence and exports emit truthful success counters once', async ({ page }) => {
  const events = await analytics(page);
  const id = await seedProject(page);
  await page.goto(`/app?test=1#project/${id}`);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  await page.getByTestId('start-recording').click();
  await expect(page.getByTestId('stop-recording')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.metrics?.elapsedMs ?? 0)).toBeGreaterThanOrEqual(2000);
  await page.getByTestId('stop-recording').click();
  await expect(page.getByTestId('recording-results')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await import('/src/projects/store.ts')).listProjectTakes().length)).toBe(1);

  await page.getByTestId('recording-results').locator('details.original-download').first().locator('summary').click();
  const original = page.waitForEvent('download');
  await page.getByTestId('download-landscape').click();
  await original;
  const prepared = page.waitForEvent('download');
  await page.getByTestId('recording-results').getByRole('button', { name: 'Baixar vídeo', exact: true }).first().click();
  await prepared;
  await expect(page.getByTestId('download-compatible-landscape')).toBeVisible();
  const repeated = page.waitForEvent('download');
  await page.getByTestId('download-compatible-landscape').click();
  await repeated;
  await flushAnalytics(page);
  await expect.poll(() => events.some(item => item.event === 'recording_saved') && events.some(item => item.event === 'export_prepared')).toBe(true);

  for (const event of ['recording_started', 'recording_completed', 'recording_saved', 'export_started', 'export_prepared']) expect(events.filter(item => item.event === event), event).toHaveLength(1);
  expect(events.filter(item => item.event === 'studio_opened').length).toBeGreaterThanOrEqual(1);
  expect(events.filter(item => item.event === 'capture_requested' && item.properties.stage === 'record_intent')).toHaveLength(1);
  expect(events.filter(item => item.event === 'capture_ready' && item.properties.stage === 'record_intent')).toHaveLength(1);
  const complete = events.find(item => item.event === 'recording_completed')!.properties;
  expect(complete).toMatchObject({ source_kind: 'test', resolution: '360', target_fps: 30 });
  expect(complete.recording_duration_ms).toBeGreaterThanOrEqual(2000);
  expect(complete.landscape_frames).toBeGreaterThan(0);
  expect(complete.measured_capture_fps).toBeGreaterThan(0);
  expect(events.find(item => item.event === 'recording_saved')!.properties.outcome).toBe('complete');
  expect(events.filter(item => item.event === 'download_requested').map(item => item.properties.download_kind)).toEqual(['original', 'compatible', 'compatible']);
  expect(events.filter(item => ['recording_failed', 'recording_save_failed', 'export_failed'].includes(item.event))).toHaveLength(0);
  expect(JSON.stringify(events)).not.toContain('PRIVATE_ANALYTICS_PROJECT');
});

test('permission denial contributes a categorized failed attempt without a fake recording success', async ({ page }) => {
  const events = await analytics(page);
  await page.addInitScript(() => {
    const query = navigator.permissions.query.bind(navigator.permissions);
    Object.defineProperty(navigator.permissions, 'query', { value: (descriptor: PermissionDescriptor) => descriptor.name === 'camera' || descriptor.name === 'microphone' ? Promise.resolve({ state: 'prompt' }) : query(descriptor) });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('PRIVATE_CAMERA_NAME SECRET_PERMISSION_DETAIL', 'NotAllowedError'); } });
  });
  const id = await seedProject(page);
  await page.goto(`/app#project/${id}`);
  await expect(page.getByTestId('start-recording')).toBeEnabled();
  await page.getByTestId('start-recording').click();
  await expect(page.locator('.main-error, .error-banner, [role="alert"]').first()).toBeVisible();
  await flushAnalytics(page);
  await expect.poll(() => events.filter(item => item.event === 'capture_failed').length).toBe(1);
  const failed = events.filter(item => item.event === 'capture_failed');
  expect(failed).toHaveLength(1);
  expect(failed[0].properties).toMatchObject({ stage: 'record_intent', error_code: 'permission_denied' });
  expect(events.filter(item => ['recording_started', 'recording_completed', 'recording_saved'].includes(item.event))).toHaveLength(0);
  expect(JSON.stringify(events)).not.toMatch(/PRIVATE_CAMERA_NAME|SECRET_PERMISSION_DETAIL/);
});

test('detail original downloads remain measured when compatible export fails', async ({ page }) => {
  const events = await analytics(page);
  const seeded = await seedRecordingReview(page);
  await openRecordingLibrary(page, seeded.projectId);
  await openRecordingDetail(page);
  for (const label of ['Original horizontal', 'Original vertical']) {
    await page.getByRole('button', { name: 'Baixar gravação' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await download;
  }
  await page.route('**/export/ffmpeg-core.js', route => route.abort());
  await page.getByRole('button', { name: 'Baixar gravação' }).click();
  await page.getByRole('menuitem', { name: /Baixar horizontal em MP4/ }).click();
  await expect(page.locator('.recording-detail-error')).toBeVisible();
  await flushAnalytics(page);
  await expect.poll(() => events.filter(item => item.event === 'export_failed').length).toBe(1);
  expect(events.filter(item => item.event === 'download_requested').map(item => item.properties.orientation)).toEqual(['landscape', 'portrait']);
  expect(events.filter(item => item.event === 'export_started')).toHaveLength(1);
  expect(events.filter(item => item.event === 'export_failed')).toHaveLength(1);
  expect(events.filter(item => item.event === 'export_prepared')).toHaveLength(0);
});
