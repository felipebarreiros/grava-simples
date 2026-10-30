import { test, expect, type Page } from './fixtures/auth';

async function trackCapture(page: Page, hold = false) {
  await page.addInitScript(hold => {
    (window as any).__cameraStreams = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await capture(constraints);
      (window as any).__cameraStreams.push(stream);
      if (hold) await new Promise<void>(resolve => {
        (window as any).__releaseCapture = resolve;
      });
      return stream;
    };
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async descriptor =>
      descriptor.name === 'camera' || descriptor.name === 'microphone'
        ? { state: 'granted' } as PermissionStatus
        : query(descriptor);
  }, hold);
}

const status = (page: Page) => page.evaluate(() => (window as any).__recorderTest?.status);
const tracks = (page: Page) => page.evaluate(() =>
  (window as any).__cameraStreams.map((stream: MediaStream) =>
    stream.getTracks().map(track => track.readyState),
  ) as MediaStreamTrackState[][],
);

test('leaving a project releases camera and microphone, and reopening restores a fresh preview', async ({ page }) => {
  await trackCapture(page);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Abrir projeto Meu primeiro projeto' }).click();
  await expect.poll(() => status(page)).toBe('ready');
  expect((await tracks(page))[0]).toEqual(['live', 'live']);

  await page.getByRole('button', { name: 'Todos os projetos', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Suas ideias, em cena.' })).toBeVisible();
  await expect.poll(() => tracks(page)).toEqual([['ended', 'ended']]);
  await expect.poll(() => status(page)).toBe('idle');

  await page.getByRole('button', { name: 'Abrir projeto Meu primeiro projeto' }).click();
  await expect.poll(() => status(page)).toBe('ready');
  expect(await tracks(page)).toEqual([['ended', 'ended'], ['live', 'live']]);
});

test('switching projects releases the previous camera before starting the next preview', async ({ page }) => {
  await trackCapture(page);
  await page.goto('/app');
  const secondId = await page.evaluate(async () => {
    const store = await import('/src/projects/store.ts');
    return store.createProject('Outro projeto').id;
  });
  await page.reload();
  await page.getByRole('button', { name: 'Abrir projeto Meu primeiro projeto' }).click();
  await expect.poll(() => status(page)).toBe('ready');

  await page.getByTestId(`project-nav-${secondId}`).click();
  await expect.poll(() => status(page)).toBe('ready');
  await expect(page).toHaveURL(new RegExp(`#project/${secondId}$`));
  expect(await tracks(page)).toEqual([['ended', 'ended'], ['live', 'live']]);
});

test('a camera request resolving after the studio unmounts immediately releases its tracks', async ({ page }) => {
  await trackCapture(page, true);
  await page.goto('/app');
  await page.getByRole('button', { name: 'Abrir projeto Meu primeiro projeto' }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseCapture)).toBe('function');

  await page.evaluate(() => {
    history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Uma gravação.');
  await page.evaluate(() => (window as any).__releaseCapture());
  await expect.poll(() => tracks(page)).toEqual([['ended', 'ended']]);
});
