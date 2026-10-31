import { gunzipSync } from 'node:zlib';
import { test, expect, type Page, type Request } from './fixtures/auth';

// This suite requires the dedicated server with fake analytics credentials. It
// never contacts PostHog: every analytics request is fulfilled inside Playwright.
test.skip(process.env.ANALYTICS_TEST_ENABLED !== 'true', 'Run with fake PostHog credentials and ANALYTICS_TEST_ENABLED=true.');
test.use({ authState: 'signed-out' });

type Captured = { path: string; payload: any };

function decode(request: Request): unknown {
  let bytes = request.postDataBuffer();
  if (!bytes?.length) return null;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const source = bytes.toString('utf8');
  try { return JSON.parse(source); } catch {
    const data = new URLSearchParams(source).get('data');
    if (!data) throw new Error(`Unexpected analytics transport at ${new URL(request.url()).pathname}`);
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  }
}

async function intercept(page: Page) {
  const captured: Captured[] = [];
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' });
    Object.defineProperty(navigator, 'userAgentData', { get: () => ({
      brands: [{ brand: 'Google Chrome', version: '145' }], mobile: false, platform: 'Linux',
      getHighEntropyValues: async () => ({ platform: 'Linux', platformVersion: '6.0.0', architecture: 'x86', bitness: '64', model: '', uaFullVersion: '145.0.0.0' }),
    }) });
  });
  await page.route('https://posthog.test/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && !path.startsWith('/flags')) captured.push({ path, payload: decode(request) });
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        status: 1, featureFlags: {}, featureFlagPayloads: {}, supportedCompression: ['gzip'],
        autocapture_opt_out: false, capturePerformance: true,
        errorTracking: { autocaptureExceptions: true }, logs: { captureConsoleLogs: false },
        sessionRecording: { endpoint: '/s/', minimumDurationMilliseconds: 0, sampleRate: '1', recordCanvas: false },
      }),
    });
  });
  // A misconfigured SDK must not accidentally send this suite to the real service.
  await page.route(/https:\/\/[^/]*posthog\.com\//, route => route.abort());
  return captured;
}

function events(captured: Captured[]): any[] {
  return captured.flatMap(({ payload }) => Array.isArray(payload) ? payload : payload?.batch ?? [payload]).filter(Boolean);
}

function unpackReplay(value: unknown): unknown {
  if (typeof value === 'string' && value.charCodeAt(0) === 0x1f && value.charCodeAt(1) === 0x8b) {
    return unpackReplay(JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString('utf8')));
  }
  if (Array.isArray(value)) return value.map(unpackReplay);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unpackReplay(entry)]));
  return value;
}

async function clientState(page: Page) {
  return page.evaluate(async () => {
    const { initializeAnalytics } = await import('/src/analytics/client.ts');
    const client = await initializeAnalytics();
    return client ? { id: client.get_distinct_id(), identified: client._isIdentified(), session: client.get_session_id() } : null;
  });
}

test('real SDK sanitizes auth URLs, creator events, and exception content', async ({ page }) => {
  const captured = await intercept(page);
  await page.goto('/login?__clerk_ticket=SECRET_AUTH_TOKEN&redirect_url=PRIVATE_REDIRECT#PRIVATE_HASH', {
    referer: `${process.env.TEST_BASE_URL}/app?ticket=SECRET_AUTH_TOKEN&return=PRIVATE_REDIRECT`,
  });
  await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
  await expect.poll(() => clientState(page)).not.toBeNull();
  await page.evaluate(async () => {
    const analytics = await import('/src/analytics/client.ts');
    analytics.trackCreatorEvent('transcript_downloaded', { format: 'srt' });
    const error = new Error('PRIVATE_TRANSCRIPT_TEXT SECRET_AUTH_TOKEN');
    error.stack = `Error: PRIVATE_TRANSCRIPT_TEXT SECRET_AUTH_TOKEN\n    at save (${location.origin}/assets/recording-review.js?ticket=SECRET_AUTH_TOKEN:42:9)`;
    analytics.reportApplicationError(error, 'transcription');
    const client = await analytics.initializeAnalytics();
    window.dispatchEvent(new ErrorEvent('error', { message: 'PRIVATE_AUTOCAPTURE_TEXT', error: new Error('PRIVATE_AUTOCAPTURE_TEXT') }));
    await client?.shutdown();
  });
  await expect.poll(() => events(captured).some(event => event.event === 'transcript_downloaded')).toBe(true);
  await expect.poll(() => events(captured).filter(event => event.event === '$exception').length).toBeGreaterThanOrEqual(2);
  const payload = JSON.stringify(events(captured).filter(event => event.event !== '$snapshot'));
  for (const secret of ['SECRET_AUTH_TOKEN', 'PRIVATE_REDIRECT', 'PRIVATE_HASH', 'PRIVATE_TRANSCRIPT_TEXT', 'PRIVATE_AUTOCAPTURE_TEXT']) expect(payload).not.toContain(secret);
  expect(payload).toContain('/assets/recording-review.js');
  expect(events(captured).find(event => event.event === '$exception').properties.$exception_list[0].stacktrace.frames[0].lineno).toBe(42);
  const pageview = events(captured).find(event => event.event === '$pageview');
  expect(pageview.properties.$current_url).toMatch(/\/login$/);
  expect(events(captured).find(event => event.event === 'transcript_downloaded').properties.format).toBe('srt');
});

test('real SDK identifies returning accounts and resets identity on logout and account change', async ({ page }) => {
  await intercept(page);
  await page.goto('/');
  await expect.poll(() => clientState(page)).not.toBeNull();
  const anonymous = await clientState(page);
  await page.evaluate(() => {
    (window as any).__clerkFixture = { ...(window as any).__clerkFixture, state: 'signed-in' };
    sessionStorage.setItem('grava-clerk-test-state', JSON.stringify((window as any).__clerkFixture));
    window.dispatchEvent(new Event('clerk-fixture-change'));
  });
  await expect.poll(async () => (await clientState(page))?.id).toBe('user_fixture');
  await page.reload();
  await expect.poll(async () => (await clientState(page))?.id).toBe('user_fixture');
  await page.evaluate(() => {
    (window as any).__clerkFixture = { ...(window as any).__clerkFixture, state: 'signed-out' };
    sessionStorage.setItem('grava-clerk-test-state', JSON.stringify((window as any).__clerkFixture));
    window.dispatchEvent(new Event('clerk-fixture-change'));
  });
  await expect.poll(async () => (await clientState(page))?.identified).toBe(false);
  await page.evaluate(async () => (await import('/src/analytics/client.ts')).identifyAnalytics('user_analytics_first'));
  await expect.poll(async () => (await clientState(page))?.id).toBe('user_analytics_first');
  await page.reload();
  // Clerk resolves signed-out on this page; the bridge clears persisted identity.
  await expect.poll(async () => (await clientState(page))?.identified).toBe(false);
  expect((await clientState(page))?.id).not.toBe('user_analytics_first');
  await page.evaluate(async () => (await import('/src/analytics/client.ts')).identifyAnalytics('user_analytics_first'));
  await expect.poll(async () => (await clientState(page))?.identified).toBe(true);
  const sessionBeforeSwitch = (await clientState(page))?.session;
  await page.evaluate(async () => (await import('/src/analytics/client.ts')).identifyAnalytics('user_analytics_second'));
  await expect.poll(async () => (await clientState(page))?.id).toBe('user_analytics_second');
  expect((await clientState(page))?.session).not.toBe(sessionBeforeSwitch);
  await page.evaluate(async () => (await import('/src/analytics/client.ts')).identifyAnalytics(null));
  await expect.poll(async () => (await clientState(page))?.identified).toBe(false);
  expect((await clientState(page))?.id).not.toBe(anonymous?.id);
});

test('signup entry and an authenticated Clerk session are captured without counting reloads as signups', async ({ page }) => {
  const captured = await intercept(page);
  await page.goto('/signup');
  await expect(page.getByTestId('clerk-sign-up')).toBeVisible();
  await expect.poll(() => clientState(page)).not.toBeNull();
  await page.evaluate(() => {
    (window as any).__clerkFixture = { ...(window as any).__clerkFixture, state: 'signed-in' };
    sessionStorage.setItem('grava-clerk-test-state', JSON.stringify((window as any).__clerkFixture));
    window.dispatchEvent(new Event('clerk-fixture-change'));
  });
  await expect(page).toHaveURL(/\/app/);
  await expect.poll(async () => (await clientState(page))?.id).toBe('user_fixture');
  await page.evaluate(async () => { await (await (await import('/src/analytics/client.ts')).initializeAnalytics())?.shutdown(); });
  await expect.poll(() => events(captured).filter(event => event.event === 'account_authenticated').length).toBe(1);
  expect(events(captured).filter(event => event.event === 'signup_viewed')).toHaveLength(1);
  expect(events(captured).find(event => event.event === 'account_authenticated').properties.distinct_id).toBe('user_fixture');
  await page.reload();
  await expect.poll(async () => (await clientState(page))?.id).toBe('user_fixture');
  await page.evaluate(async () => { await (await (await import('/src/analytics/client.ts')).initializeAnalytics())?.shutdown(); });
  expect(events(captured).filter(event => event.event === 'account_authenticated')).toHaveLength(1);
  expect(events(captured).filter(event => event.event === 'signup_viewed')).toHaveLength(1);
  expect(events(captured).some(event => event.event === 'signed_up')).toBe(false);
});

test('replays mask content while structured logs and same-origin tracing retain correlation', async ({ page }) => {
  const captured = await intercept(page);
  let traceHeaders: Record<string, string> = {};
  await page.route('**/analytics-trace-fixture', async route => {
    traceHeaders = await route.request().allHeaders();
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto('/');
  await expect.poll(() => clientState(page)).not.toBeNull();
  const config = await page.evaluate(async () => {
    const { initializeAnalytics, trackCreatorEvent } = await import('/src/analytics/client.ts');
    const client = (await initializeAnalytics())!;
    const element = document.createElement('div');
    element.id = 'analytics-private-fixture';
    element.textContent = 'PRIVATE_PROJECT_NAME';
    element.innerHTML += '<input value="PRIVATE_PASSWORD"><video src="blob:PRIVATE_VIDEO_URL"></video><img src="data:image/png,PRIVATE_THUMBNAIL">';
    document.body.append(element);
    trackCreatorEvent('recording_opened');
    await client.logs?.flush();
    await fetch('/analytics-trace-fixture');
    const replay = client.config.session_recording;
    return {
      masksInputs: replay.maskAllInputs, masksText: replay.maskTextSelector, masksAttributes: replay.maskAllElementAttributes,
      mediaBlocked: [...element.querySelectorAll('video,img')].every(item => item.matches(replay.blockSelector!)),
      recordsCanvas: replay.captureCanvas?.recordCanvas, bodies: replay.recordBody, headers: replay.recordHeaders,
      session: client.get_session_id(), id: client.get_distinct_id(),
    };
  });
  expect(config).toMatchObject({ masksInputs: true, masksText: '*', masksAttributes: true, mediaBlocked: true, recordsCanvas: false, bodies: false, headers: false });
  expect(traceHeaders['x-posthog-distinct-id']).toBe(config.id);
  expect(traceHeaders['x-posthog-session-id']).toBe(config.session);
  await expect.poll(() => JSON.stringify(captured.filter(item => item.path.includes('/logs')))).toContain('recording_opened');
  const logs = JSON.stringify(captured.filter(item => item.path.includes('/logs')));
  expect(logs).toContain('recording_opened');
  expect(logs).toContain(config.session);
  expect(logs).not.toContain('PRIVATE_PROJECT_NAME');
  await page.locator('#analytics-private-fixture input').fill('PRIVATE_PASSWORD');
  await page.getByRole('heading', { level: 1 }).click();
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/analytics/client.ts')).initializeAnalytics())?.sessionRecordingStarted())).toBe(true);
  await expect.poll(() => events(captured).some(event => event.event === '$snapshot')).toBe(true);
  const replay = unpackReplay(events(captured).filter(event => event.event === '$snapshot'));
  const snapshots = JSON.stringify(replay);
  expect(snapshots).toContain('"type":2'); // A real full DOM snapshot, decoded from gzip.
  for (const secret of ['PRIVATE_PROJECT_NAME', 'PRIVATE_PASSWORD', 'PRIVATE_VIDEO_URL', 'PRIVATE_THUMBNAIL']) expect(snapshots).not.toContain(secret);
});
