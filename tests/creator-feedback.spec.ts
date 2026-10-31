import { gunzipSync } from 'node:zlib';
import { test, expect, type Page, type Request } from './fixtures/auth';

// Run against the dedicated Vite server with fake PostHog credentials. Every
// analytics transport is intercepted; no real feedback response is submitted.
test.skip(process.env.ANALYTICS_TEST_ENABLED !== 'true', 'Requires the isolated analytics test server.');

const surveyId = '01a18fa4-1dff-0000-ff0d-b71c893d0ad9';
const questionId = '496660c1-8a9f-4a25-9997-a53ec1e1713f';
const targetingKey = 'survey-targeting-20b7d2d8e1-custom';
const question = 'O que você queria fazer e não conseguiu?';
const responseKey = `$survey_response_${questionId}`;
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

async function intercept(page: Page): Promise<Captured[]> {
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
    const survey = {
      id: surveyId, name: 'GravaSimples: feedback após a primeira gravação', type: 'api',
      schedule: 'once', start_date: '2026-10-01T00:00:00.000Z', end_date: null,
      current_iteration: null, conditions: null, internal_targeting_flag_key: targetingKey,
      questions: [{ id: questionId, type: 'open', question, optional: true, buttonText: 'Enviar feedback', description: 'Sua resposta ajuda a melhorar o GravaSimples. Não inclua dados pessoais nem o conteúdo da gravação.' }],
      appearance: { placeholder: 'Conte o que faltou para você…', thankYouMessageHeader: 'Obrigado pelo feedback!' },
    };
    await route.fulfill({
      contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(path === '/api/surveys/' ? { surveys: [survey] } : {
        status: 1, supportedCompression: ['gzip'], surveys: true,
        featureFlags: { [targetingKey]: true }, featureFlagPayloads: {},
        flags: { [targetingKey]: { key: targetingKey, enabled: true, variant: null, reason: { code: 'condition_match' }, metadata: { id: 1014821, version: 2 } } },
        autocapture_opt_out: false, capturePerformance: true,
        errorTracking: { autocaptureExceptions: true }, logs: { captureConsoleLogs: false },
        sessionRecording: { endpoint: '/s/', minimumDurationMilliseconds: 0, sampleRate: '1', recordCanvas: false },
      }),
    });
  });
  await page.route(/https:\/\/[^/]*posthog\.com\//, route => route.abort());
  return captured;
}

function events(captured: Captured[]): any[] {
  return captured.flatMap(({ payload }) => Array.isArray(payload) ? payload : payload?.batch ?? [payload]).filter(Boolean);
}

async function analyticsModuleUrl(page: Page) {
  // Vite adds a timestamp after HMR edits. Import the same module instance the
  // running app loaded, including its auth lifecycle state.
  return page.evaluate(() => performance.getEntriesByType('resource').find(entry =>
    new URL(entry.name).pathname === '/src/analytics/client.ts')?.name ?? '/src/analytics/client.ts');
}

async function openStudio(page: Page) {
  await page.route('**/creator-feedback-storage-fixture', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>Creator feedback storage fixture</body></html>',
  }));
  await page.goto('/creator-feedback-storage-fixture');
  const projectId = await page.evaluate(async () => {
    const store = await import('/src/projects/store.ts');
    const project = store.loadProjects()[0];
    project.name = 'Projeto de feedback';
    project.settings.resolution = '360';
    store.saveProject(project);
    return project.id;
  });
  await page.goto(`/app?test=1#project/${projectId}`);
  await expect(page.locator('.studio-layout')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  const moduleUrl = await analyticsModuleUrl(page);
  await expect.poll(() => page.evaluate(async moduleUrl => {
    const client = await (await import(moduleUrl)).initializeAnalytics();
    return client?.get_distinct_id();
  }, moduleUrl)).toBe('user_fixture');
}

async function saved(page: Page, outcome: 'complete' | 'recovered' = 'complete') {
  await page.evaluate(async ({ outcome, moduleUrl }) => {
    (await import(moduleUrl)).trackCreatorEvent('recording_saved', { outcome });
  }, { outcome, moduleUrl: await analyticsModuleUrl(page) });
}

async function expectFeedback(page: Page) {
  const dialog = page.getByRole('dialog', { name: question });
  try { await expect(dialog).toBeVisible({ timeout: 15_000 }); } catch (error) {
    const diagnostic = await page.evaluate(async ({ surveyId, targetingKey, moduleUrl }) => {
      const client = await (await import(moduleUrl)).initializeAnalytics();
      const state = await import('/src/analytics/feedbackState.ts');
      return { feedback: state.feedbackState(surveyId, 'user_fixture'), user: client?.get_distinct_id(), optedOut: client?.has_opted_out_capturing(), flag: client?.isFeatureEnabled(targetingKey, { send_event: false }), surveyDefinitions: client?.get_property('$surveys'), dialogs: document.querySelectorAll('[role="dialog"]').length, recorder: (window as any).__recorderTest?.snapshot?.state };
    }, { surveyId, targetingKey, moduleUrl: await analyticsModuleUrl(page) });
    throw new Error(`${String(error)}\nFeedback diagnostic: ${JSON.stringify(diagnostic)}`);
  }
  return dialog;
}

test('feedback waits for complete save and idle UI, and only explicit submission exports the answer', async ({ page }) => {
  const captured = await intercept(page);
  await openStudio(page);
  await page.waitForTimeout(5_500);
  await expect(page.getByRole('dialog', { name: question })).toHaveCount(0);
  await saved(page, 'recovered');
  await page.waitForTimeout(5_500);
  await expect(page.getByRole('dialog', { name: question })).toHaveCount(0);

  await page.getByTestId('settings-trigger').click();
  await expect(page.getByRole('dialog', { name: 'Preferências' })).toBeVisible();
  await saved(page);
  await page.waitForTimeout(5_500);
  await expect(page.getByRole('dialog', { name: question })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const dialog = await expectFeedback(page);
  await expect(dialog.getByRole('button', { name: 'Enviar feedback' })).toBeDisabled();
  await dialog.getByLabel('Seu comentário (opcional)').fill('Gostaria de editar as palavras antes de publicar.');
  await page.waitForTimeout(3_500);
  expect(events(captured).filter(event => event.event === 'survey sent')).toHaveLength(0);
  expect(JSON.stringify(captured)).not.toContain('Gostaria de editar as palavras antes de publicar.');
  await dialog.getByRole('button', { name: 'Enviar feedback' }).click();
  await expect(page.getByRole('dialog', { name: 'Obrigado pelo feedback!' })).toBeVisible();
  await expect.poll(() => events(captured).filter(event => event.event === 'survey sent').length).toBe(1);
  const submitted = events(captured).find(event => event.event === 'survey sent');
  expect(submitted.properties).toMatchObject({ $survey_id: surveyId, $survey_completed: true, [responseKey]: 'Gostaria de editar as palavras antes de publicar.' });
  expect(submitted.properties.$survey_submission_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(submitted.properties.$survey_questions).toEqual([{ id: questionId, question }]);
  expect(events(captured).filter(event => event.event === 'survey shown')).toHaveLength(1);
  expect(JSON.stringify(captured.filter(item => item.path.includes('/logs')))).not.toContain('Gostaria de editar as palavras antes de publicar.');
  await page.getByRole('dialog', { name: 'Obrigado pelo feedback!' }).getByRole('button', { name: 'Fechar', exact: true }).last().click();
  await page.reload();
  await expect(page.locator('.studio-layout')).toBeVisible();
  await saved(page);
  await page.waitForTimeout(5_500);
  await expect(page.getByRole('dialog', { name: question })).toHaveCount(0);
  expect(events(captured).filter(event => event.event === 'survey sent')).toHaveLength(1);
});

test('dismissal exports no answer and prevents repeated prompts after reload', async ({ page }) => {
  const captured = await intercept(page);
  await openStudio(page);
  await saved(page);
  const dialog = await expectFeedback(page);
  await dialog.getByLabel('Seu comentário (opcional)').fill('Rascunho privado que eu não enviei.');
  await dialog.getByRole('button', { name: 'Agora não' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => events(captured).filter(event => event.event === 'survey dismissed').length).toBe(1);
  const dismissed = events(captured).find(event => event.event === 'survey dismissed');
  expect(dismissed.properties.$survey_id).toBe(surveyId);
  expect(dismissed.properties[responseKey]).toBeUndefined();
  expect(JSON.stringify(captured)).not.toContain('Rascunho privado que eu não enviei.');
  await page.reload();
  await expect(page.locator('.studio-layout')).toBeVisible();
  await saved(page);
  await page.waitForTimeout(5_500);
  await expect(dialog).toHaveCount(0);
  expect(events(captured).filter(event => event.event === 'survey shown')).toHaveLength(1);
  expect(events(captured).filter(event => event.event === 'survey sent')).toHaveLength(0);
});

test('opting out of analytics prevents feedback eligibility and display', async ({ page }) => {
  const captured = await intercept(page);
  await openStudio(page);
  await page.evaluate(async moduleUrl => {
    const client = await (await import(moduleUrl)).initializeAnalytics();
    client?.opt_out_capturing();
  }, await analyticsModuleUrl(page));
  await saved(page);
  await page.waitForTimeout(5_500);
  await expect(page.getByRole('dialog', { name: question })).toHaveCount(0);
  expect(events(captured).filter(event => ['survey shown', 'survey sent', 'survey dismissed'].includes(event.event))).toHaveLength(0);
});
