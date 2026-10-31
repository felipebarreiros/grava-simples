import { test, expect } from './fixtures/auth';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.MediaRecorder;
    (window as any).__recorderStarts = [];
    window.MediaRecorder = class extends Native {
      start(timeslice?: number) {
        (window as any).__recorderStarts.push(performance.now());
        super.start(timeslice);
      }
    };
  });
  await page.route('**/api/recordings*', route => route.fulfill({ json: { configured: false, recordings: [], usedBytes: 0, maxStorageBytes: 0 } }));
  await page.route('**/api/transcriptions*', route => route.fulfill({ json: { configured: false, status: 'idle', maxUploadBytes: 0 } }));
  await page.goto('/app?test=1');
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
});

test('cancel before zero leaves both actual recorders stopped and saves no take', async ({ page }) => {
  await page.getByTestId('start-recording').click();
  await expect(page.getByTestId('recording-countdown')).toContainText('3');
  expect(await page.evaluate(() => (window as any).__recorderStarts.length)).toBe(0);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(3300);
  expect(await page.evaluate(() => (window as any).__recorderStarts.length)).toBe(0);
  expect(await page.evaluate(async () => (await import('/src/projects/store.ts')).listProjectTakes().length)).toBe(0);
  await expect(page.getByTestId('start-recording')).toBeEnabled();
});

test('Escape and browser navigation cancel their pending starts', async ({ page }) => {
  await page.getByTestId('start-recording').click();
  await expect(page.getByTestId('recording-countdown')).toContainText('3');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByTestId('start-recording').click();
  await expect(page.getByTestId('recording-countdown')).toContainText('3');
  await page.evaluate(() => { location.hash = '#project/cancelled-navigation'; });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.waitForTimeout(3300);
  expect(await page.evaluate(() => (window as any).__recorderStarts.length)).toBe(0);
});

test('signing out during countdown cannot start a recorder after the account unmounts', async ({ page }) => {
  await page.getByTestId('start-recording').click();
  await expect(page.getByTestId('recording-countdown')).toContainText('3');
  await page.evaluate(() => {
    (window as any).__clerkFixture = { ...(window as any).__clerkFixture, state: 'signed-out' };
    window.dispatchEvent(new Event('clerk-fixture-change'));
  });
  await expect(page.getByTestId('clerk-sign-in')).toBeVisible();
  await page.waitForTimeout(3300);
  expect(await page.evaluate(() => (window as any).__recorderStarts.length)).toBe(0);
});

test('three complete countdown seconds precede actual dual recording and account-local persistence', async ({ page }) => {
  const clickedAt = await page.evaluate(() => performance.now());
  await page.getByTestId('start-recording').click();
  for (const digit of ['3', '2', '1']) {
    await expect(page.getByTestId('recording-countdown')).toContainText(digit);
    expect(await page.evaluate(() => (window as any).__recorderStarts.length)).toBe(0);
  }
  await expect(page.getByTestId('stop-recording')).toBeVisible();
  const starts = await page.evaluate(() => (window as any).__recorderStarts as number[]);
  expect(starts).toHaveLength(2);
  expect(starts[0] - clickedAt).toBeGreaterThanOrEqual(3000);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.metrics?.elapsedMs ?? 0)).toBeGreaterThanOrEqual(1500);
  await page.getByTestId('stop-recording').click();
  await expect(page.getByTestId('recording-results')).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await import('/src/projects/store.ts')).listProjectTakes().length)).toBe(1);
  const bytes = await page.evaluate(async () => {
    const take = (await import('/src/projects/store.ts')).listProjectTakes()[0];
    const files = await (await import('/src/media/storage.ts')).readRecordingFiles(take.id);
    return [files.landscape.size, files.portrait.size];
  });
  expect(bytes.every(size => size > 1000)).toBe(true);
});
