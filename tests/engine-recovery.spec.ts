import { expect, test, type Page } from './fixtures/auth';

const state = (page: Page): Promise<any> => page.evaluate(() => (window as any).__recorderTest);

test('a temporary engine download failure recovers automatically using the actual Wasm file', async ({ page }) => {
  let requests = 0;
  await page.route('**/engine/obs-core.wasm', async route => {
    requests++;
    if (requests === 1) await route.fulfill({ status: 503, body: 'Temporarily unavailable' });
    else await route.continue();
  });
  await page.goto('/app?test=1', { waitUntil: 'networkidle' });
  await expect.poll(async () => (await state(page))?.ready).toBe(true);
  expect(requests).toBe(2);
  await expect(page.getByTestId('retry-engine-load')).toHaveCount(0);
  await expect.poll(async () => (await state(page))?.error ?? '').toBe('');
});

test('failed engine access can be retried without reloading or losing the project', async ({ page }) => {
  let blocked = true, requests = 0;
  await page.route('**/engine/obs-core.wasm', async route => {
    requests++;
    if (blocked) await route.fulfill({ status: 403, body: 'Forbidden' });
    else await route.continue();
  });
  await page.goto('/app?test=1', { waitUntil: 'networkidle' });
  const retry = page.getByTestId('retry-engine-load');
  await expect(retry).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('Não conseguimos carregar o estúdio');
  await expect(page.getByTestId('start-recording')).toBeDisabled();
  const before = (await state(page)).project;
  const documentId = await page.evaluate(() => {
    const marker = crypto.randomUUID();
    (window as any).__engineRetryDocument = marker;
    return marker;
  });
  expect(before.id).toBeTruthy();
  expect(requests).toBe(1);

  blocked = false;
  await retry.click();
  await expect.poll(async () => (await state(page))?.ready).toBe(true);
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const after = (await state(page)).project;
  expect({ id: after.id, name: after.name, scenes: after.scenes.map((scene: any) => scene.id) })
    .toEqual({ id: before.id, name: before.name, scenes: before.scenes.map((scene: any) => scene.id) });
  expect(requests).toBe(2);
  expect(await page.evaluate(() => (window as any).__engineRetryDocument)).toBe(documentId);
});
