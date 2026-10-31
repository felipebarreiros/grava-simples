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

async function startCornerResize(page: Page, orientation: Orientation, corner: 'nw' | 'ne' | 'se' | 'sw') {
  const editor = page.getByTestId(`canvas-editor-${orientation}`);
  const bounds = await editor.boundingBox();
  const handle = await page.getByTestId(`resize-${orientation}-${corner}`).boundingBox();
  expect(bounds).toBeTruthy();
  expect(handle).toBeTruthy();
  await editor.evaluate(element => element.addEventListener('pointerdown', event => {
    element.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId));
  }, { once: true }));
  const start = { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  return { editor, bounds: bounds!, start, pointerId: Number(await editor.getAttribute('data-test-pointer-id')) };
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

test('corner resizing preserves current proportions and the opposite corner in both formats', async ({ page }) => {
  await openStudio(page);
  await prepare(page);
  const id = await addText(page);
  const initial = { x: .25, y: .22, width: .3, height: .18 };
  await setFrame(page, 'landscape', initial);
  await setFrame(page, 'portrait', initial);
  for (const orientation of ['landscape', 'portrait'] as const) {
    const other = orientation === 'landscape' ? 'portrait' : 'landscape';
    for (const [index, corner] of (['nw', 'ne', 'se', 'sw'] as const).entries()) {
      await setFrame(page, orientation, initial);
      const untouched = await frameOf(page, id, other);
      const { bounds, start } = await startCornerResize(page, orientation, corner);
      // Alternate mostly-horizontal and mostly-vertical drags; both must scale.
      const dx = (corner.includes('w') ? -1 : 1) * (index % 2 ? .025 : .09);
      const dy = (corner.includes('n') ? -1 : 1) * (index % 2 ? .09 : .025);
      await page.mouse.move(start.x + dx * bounds.width, start.y + dy * bounds.height, { steps: 5 });
      await page.mouse.up();
      const resized = await frameOf(page, id, orientation);
      expect(resized.width).toBeGreaterThan(initial.width);
      expect(resized.height).toBeGreaterThan(initial.height);
      expect(resized.width / resized.height).toBeCloseTo(initial.width / initial.height, 6);
      expect(corner.includes('w') ? resized.x + resized.width : resized.x)
        .toBeCloseTo(corner.includes('w') ? initial.x + initial.width : initial.x, 6);
      expect(corner.includes('n') ? resized.y + resized.height : resized.y)
        .toBeCloseTo(corner.includes('n') ? initial.y + initial.height : initial.y, 6);
      expect(await frameOf(page, id, other)).toEqual(untouched);
    }
  }
});

test('Shift temporarily permits corner stretching and a later drag keeps the new proportions', async ({ page }) => {
  await openStudio(page);
  await prepare(page);
  const id = await addText(page);
  const initial = { x: .2, y: .24, width: .3, height: .18 };
  await setFrame(page, 'landscape', initial);
  const { bounds, start } = await startCornerResize(page, 'landscape', 'se');
  await page.keyboard.down('Shift');
  await page.mouse.move(start.x + bounds.width * .12, start.y + bounds.height * .015, { steps: 5 });
  let resized = await frameOf(page, id, 'landscape');
  expect(Math.abs(resized.width / resized.height - initial.width / initial.height)).toBeGreaterThan(.2);
  await page.keyboard.up('Shift');
  await page.mouse.move(start.x + bounds.width * .13, start.y + bounds.height * .02, { steps: 3 });
  resized = await frameOf(page, id, 'landscape');
  expect(resized.width / resized.height).toBeCloseTo(initial.width / initial.height, 6);
  await page.keyboard.down('Shift');
  await page.mouse.move(start.x + bounds.width * .14, start.y + bounds.height * .025, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const stretched = await frameOf(page, id, 'landscape');
  expect(Math.abs(stretched.width / stretched.height - initial.width / initial.height)).toBeGreaterThan(.2);
  const next = await startCornerResize(page, 'landscape', 'se');
  await page.mouse.move(next.start.x + next.bounds.width * .04, next.start.y + next.bounds.height * .01, { steps: 4 });
  await page.mouse.up();
  resized = await frameOf(page, id, 'landscape');
  expect(resized.width / resized.height).toBeCloseTo(stretched.width / stretched.height, 6);
  expect(resized.x).toBeCloseTo(initial.x, 6);
  expect(resized.y).toBeCloseTo(initial.y, 6);
});

test('corner resizing keeps proportions at size limits, cancels cleanly, and leaves circular cameras round', async ({ page }) => {
  await openStudio(page);
  await prepare(page);
  const id = await addText(page);
  const initial = { x: .2, y: .25, width: .6, height: .1 };
  await setFrame(page, 'landscape', initial);
  for (const [delta, limit] of [[-3, 'minimum'], [3, 'maximum']] as const) {
    await setFrame(page, 'landscape', initial);
    const active = await startCornerResize(page, 'landscape', 'se');
    await active.editor.dispatchEvent('pointermove', {
      pointerId: active.pointerId, pointerType: 'mouse',
      clientX: active.start.x + delta * active.bounds.width,
      clientY: active.start.y + delta * active.bounds.height,
    });
    await expect.poll(async () => {
      const frame = await frameOf(page, id, 'landscape');
      return limit === 'minimum' ? frame.height : frame.width;
    }).toBeCloseTo(limit === 'minimum' ? .02 : 2, 6);
    const resized = await frameOf(page, id, 'landscape');
    expect(resized.width / resized.height).toBeCloseTo(initial.width / initial.height, 6);
    if (limit === 'minimum') expect(resized.height).toBeCloseTo(.02, 6);
    else expect(resized.width).toBeCloseTo(2, 6);
    expect(resized.x).toBeCloseTo(initial.x, 6);
    expect(resized.y).toBeCloseTo(initial.y, 6);
    await active.editor.dispatchEvent('pointercancel', { pointerId: active.pointerId, pointerType: 'mouse' });
    await page.mouse.up();
    expect(await frameOf(page, id, 'landscape')).toEqual(initial);
  }

  await page.getByTestId('layer-select-camera').click();
  await page.getByTestId('camera-shape-circle').click();
  for (const orientation of ['landscape', 'portrait'] as const) {
    await setFrame(page, orientation, { x: .25, y: .25, width: .3, height: .2 });
    const active = await startCornerResize(page, orientation, 'se');
    await page.keyboard.down('Shift');
    await page.mouse.move(active.start.x + active.bounds.width * .06, active.start.y + active.bounds.height * .02, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const resized = await frameOf(page, 'camera', orientation);
    const outputRatio = orientation === 'landscape' ? 16 / 9 : 9 / 16;
    expect(resized.width / resized.height * outputRatio).toBeCloseTo(1, 6);
  }
});
