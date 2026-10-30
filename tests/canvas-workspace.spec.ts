import { expect, test, type Page } from './fixtures/auth';
import { selectValue } from './helpers';
import { mkdir } from 'node:fs/promises';

type Orientation = 'landscape' | 'portrait';
type Frame = { x: number; y: number; width: number; height: number };

const snapshot = (page: Page): Promise<any> => page.evaluate(() => (window as any).__recorderTest);
async function selectedScene(page: Page) {
  const value = await snapshot(page);
  return value.project.scenes.find((scene: any) => scene.id === value.project.selectedSceneId);
}
async function frameOf(page: Page, id: string, orientation: Orientation): Promise<Frame> {
  return (await selectedScene(page)).appearance.layers.find((layer: any) => layer.id === id).frames[orientation];
}
async function openStudio(page: Page) {
  await page.goto('/app?test=1', { waitUntil: 'networkidle' });
  await expect.poll(async () => {
    const value = await snapshot(page);
    expect(value?.error).toBeFalsy();
    return value?.ready;
  }).toBe(true);
}
async function prepare(page: Page) {
  await page.getByTestId('settings-trigger').click();
  await selectValue(page, 'source-mode-select', 'test');
  await selectValue(page, 'resolution-select', '360');
  await selectValue(page, 'fps-select', '30');
  await page.getByTestId('prepare-inputs').click();
  await expect.poll(async () => {
    const value = await snapshot(page);
    expect(value.error).toBeFalsy();
    return value.status;
  }).toBe('ready');
  await expect(page.getByTestId('prepare-inputs')).toBeEnabled();
  await page.keyboard.press('Escape');
}
async function setFrame(page: Page, orientation: Orientation, values: Frame) {
  await page.getByRole('radio', { name: `Editar formato ${orientation === 'landscape' ? 'horizontal' : 'vertical'}`, exact: true }).click();
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    const input = page.getByTestId(`layer-${key}`);
    await input.fill(String(values[key] * 100));
    await input.press('Enter');
  }
}
async function addText(page: Page) {
  const before = (await selectedScene(page)).appearance.layers.map((layer: any) => layer.id);
  await page.getByTestId('add-source').click();
  await page.getByRole('menuitem', { name: 'Texto', exact: true }).click();
  await expect.poll(async () => (await selectedScene(page)).appearance.layers.length).toBe(before.length + 1);
  const id = (await selectedScene(page)).appearance.layers.find((layer: any) => !before.includes(layer.id)).id as string;
  await page.getByTestId(`layer-select-${id}`).click();
  return id;
}
async function dragTo(page: Page, id: string, orientation: Orientation, target: { x: number; y: number }, alt = false) {
  const editor = await page.getByTestId(`canvas-editor-${orientation}`).boundingBox();
  const hit = await page.getByTestId(`canvas-layer-${orientation}-${id}`).boundingBox();
  const initial = await frameOf(page, id, orientation);
  expect(editor).toBeTruthy();
  expect(hit).toBeTruthy();
  const start = { x: hit!.x + hit!.width / 2, y: hit!.y + hit!.height / 2 };
  await page.mouse.move(start.x, start.y);
  if (alt) await page.keyboard.down('Alt');
  await page.mouse.down();
  await page.mouse.move(start.x + (target.x - initial.x) * editor!.width, start.y + (target.y - initial.y) * editor!.height, { steps: 8 });
  return { editor: editor!, initial };
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1440, height: 600 },
  { width: 1920, height: 720 },
  { width: 768, height: 900 },
  { width: 360, height: 640 },
]) {
  test(`format labels and complete output frames remain legible at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openStudio(page);
    for (const [orientation, label, ratio] of [
      ['landscape', 'Horizontal', 16 / 9],
      ['portrait', 'Vertical', 9 / 16],
    ] as const) {
      const figure = page.locator(`.${orientation}-output`);
      const caption = figure.locator('figcaption');
      await expect(caption).toBeVisible();
      await expect(caption).toContainText(label);
      await expect(caption).toContainText(orientation === 'landscape' ? '16:9' : '9:16');
      const canvas = await page.getByTestId(`${orientation}-preview`).boundingBox();
      const frame = await figure.locator('.video-frame').boundingBox();
      const workspace = await page.locator('.preview-stage').boundingBox();
      const header = await caption.boundingBox();
      const formatButton = await caption.getByRole('button').boundingBox();
      expect(canvas).toBeTruthy();
      expect(frame).toBeTruthy();
      expect(workspace).toBeTruthy();
      expect(header).toBeTruthy();
      expect(formatButton).toBeTruthy();
      expect(formatButton!.x).toBeGreaterThanOrEqual(workspace!.x);
      expect(formatButton!.x + formatButton!.width).toBeLessThanOrEqual(workspace!.x + workspace!.width);
      expect(Math.abs(canvas!.width / canvas!.height - ratio)).toBeLessThan(.015);
      expect(frame!.x).toBeGreaterThan(workspace!.x + 4);
      expect(frame!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
      expect(frame!.x + frame!.width).toBeLessThanOrEqual(workspace!.x + workspace!.width - 4);
      expect(frame!.y + frame!.height).toBeLessThanOrEqual(workspace!.y + workspace!.height + 1);
      const style = await figure.locator('.video-frame').evaluate(element => {
        const computed = getComputedStyle(element);
        return { outline: computed.outlineStyle, shadow: computed.boxShadow, border: computed.borderTopStyle };
      });
      expect(style.outline !== 'none' || style.shadow !== 'none' || style.border !== 'none').toBe(true);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    const activation = page.getByTestId('activate-camera');
    await expect(activation).toBeVisible();
    const activationBox = await activation.boundingBox();
    const emptyFrame = await page.locator('.landscape-frame').boundingBox();
    expect(activationBox).toBeTruthy();
    expect(emptyFrame).toBeTruthy();
    expect(activationBox!.x).toBeGreaterThanOrEqual(emptyFrame!.x);
    expect(activationBox!.y).toBeGreaterThanOrEqual(emptyFrame!.y);
    expect(activationBox!.x + activationBox!.width).toBeLessThanOrEqual(emptyFrame!.x + emptyFrame!.width);
    expect(activationBox!.y + activationBox!.height).toBeLessThanOrEqual(emptyFrame!.y + emptyFrame!.height);
    const image = viewport.width === 1440 && viewport.height === 900 ? 'desktop'
      : viewport.width === 1440 && viewport.height === 600 ? 'short'
      : viewport.width === 768 ? 'portrait' : undefined;
    if (image) {
      await prepare(page);
      await mkdir('.context/screenshots', { recursive: true });
      await page.screenshot({ path: `.context/screenshots/canvas-workspace-${image}.png`, fullPage: true });
    }
  });
}

test('dragging snaps each orientation to both canvas centers without changing the other frame', async ({ page }) => {
  await openStudio(page);
  await prepare(page);
  const id = await addText(page);
  const initial = { x: .1, y: .12, width: .2, height: .2 };
  await setFrame(page, 'landscape', initial);
  await setFrame(page, 'portrait', initial);
  for (const orientation of ['landscape', 'portrait'] as const) {
    const other = orientation === 'landscape' ? 'portrait' : 'landscape';
    const otherBefore = await frameOf(page, id, other);
    const editor = await page.getByTestId(`canvas-editor-${orientation}`).boundingBox();
    expect(editor).toBeTruthy();
    await dragTo(page, id, orientation, { x: .4 + 3 / editor!.width, y: .4 - 3 / editor!.height });
    await expect(page.getByTestId(`snap-guide-${orientation}-x`)).toHaveAttribute('data-position', '0.5');
    await expect(page.getByTestId(`snap-guide-${orientation}-y`)).toHaveAttribute('data-position', '0.5');
    await expect.poll(async () => (await frameOf(page, id, orientation)).x).toBeCloseTo(.4, 5);
    await expect.poll(async () => (await frameOf(page, id, orientation)).y).toBeCloseTo(.4, 5);
    expect(await frameOf(page, id, other)).toEqual(otherBefore);
    await page.mouse.up();
    await expect(page.getByTestId(`snap-guide-${orientation}-x`)).toHaveCount(0);
    await expect(page.getByTestId(`snap-guide-${orientation}-y`)).toHaveCount(0);
  }
});

test('canvas edge snapping, Alt precision and guides stay separate from recorded pixels', async ({ page }) => {
  await openStudio(page);
  await prepare(page);
  const id = await addText(page);
  await page.getByTestId('layer-text').fill('');
  for (const layer of (await selectedScene(page)).appearance.layers) {
    if (layer.id !== id && layer.visible) await page.getByTestId(`layer-eye-${layer.id}`).click();
  }
  await page.getByTestId(`layer-select-${id}`).click();
  await setFrame(page, 'landscape', { x: .2, y: .2, width: .2, height: .2 });
  const editor = await page.getByTestId('canvas-editor-landscape').boundingBox();
  expect(editor).toBeTruthy();
  const canvasData = () => page.getByTestId('landscape-preview').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await expect.poll(canvasData).not.toBe('data:,');
  const before = await canvasData();
  await dragTo(page, id, 'landscape', { x: 3 / editor!.width, y: .2 });
  await expect(page.getByTestId('snap-guide-landscape-x')).toHaveAttribute('data-position', '0');
  await expect.poll(async () => (await frameOf(page, id, 'landscape')).x).toBe(0);
  expect(await canvasData()).toBe(before);
  await page.mouse.up();
  await expect(page.getByTestId('snap-guide-landscape-x')).toHaveCount(0);

  const raw = { x: .4 + 3 / editor!.width, y: .4 - 3 / editor!.height };
  await dragTo(page, id, 'landscape', raw, true);
  await expect(page.getByTestId('snap-guide-landscape-x')).toHaveCount(0);
  await expect(page.getByTestId('snap-guide-landscape-y')).toHaveCount(0);
  await expect.poll(async () => (await frameOf(page, id, 'landscape')).x).toBeCloseTo(raw.x, 5);
  await expect.poll(async () => (await frameOf(page, id, 'landscape')).y).toBeCloseTo(raw.y, 5);
  await page.mouse.up();
  await page.keyboard.up('Alt');
  expect(Math.abs((await frameOf(page, id, 'landscape')).x - .4)).toBeGreaterThan(.001);
  const nudged = await frameOf(page, id, 'landscape');
  await page.getByTestId(`canvas-layer-landscape-${id}`).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await frameOf(page, id, 'landscape')).x).toBeCloseTo(nudged.x + 1 / 1920, 5);
});

test('canceled drags restore automatic framing and intentional offstage placement remains possible', async ({ page }) => {
  await openStudio(page);
  await prepare(page);
  const id = await addText(page);
  const layer = () => selectedScene(page).then(scene => scene.appearance.layers.find((item: any) => item.id === id));
  expect((await layer()).frames?.landscape).toBeUndefined();
  const portrait = { x: .18, y: .24, width: .3, height: .22 };
  await setFrame(page, 'portrait', portrait);
  await page.getByRole('radio', { name: 'Editar formato horizontal', exact: true }).click();
  const editor = page.getByTestId('canvas-editor-landscape');
  await editor.evaluate(element => element.addEventListener('pointerdown', event => {
    element.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId));
  }, { once: true }));
  const hit = await page.getByTestId(`canvas-layer-landscape-${id}`).boundingBox();
  expect(hit).toBeTruthy();
  const x = hit!.x + hit!.width / 2, y = hit!.y + hit!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 24, y + 16, { steps: 6 });
  await expect.poll(async () => (await layer()).frames?.landscape).not.toBeUndefined();
  const pointerId = Number(await editor.getAttribute('data-test-pointer-id'));
  expect(pointerId).toBeGreaterThan(0);
  await editor.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse' });
  await page.mouse.up();
  await expect.poll(async () => (await layer()).frames?.landscape).toBeUndefined();
  expect((await layer()).frames.portrait).toEqual(portrait);
  await expect(page.getByTestId('snap-guide-landscape-x')).toHaveCount(0);
  await expect(page.getByTestId('snap-guide-landscape-y')).toHaveCount(0);

  await setFrame(page, 'landscape', { x: .2, y: .2, width: .2, height: .2 });
  await dragTo(page, id, 'landscape', { x: -.1, y: .2 });
  await page.mouse.up();
  await expect.poll(async () => (await frameOf(page, id, 'landscape')).x).toBeCloseTo(-.1, 5);
  expect((await layer()).frames.portrait).toEqual(portrait);
});
