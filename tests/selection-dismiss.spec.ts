import { expect, test, type Page } from './fixtures/auth';
import { selectValue } from './helpers';

const state = (page: Page): Promise<any> => page.evaluate(() => (window as any).__recorderTest);
const selected = async (page: Page) => (await state(page)).selectedLayerId;

async function countdown(page: Page) {
  await page.goto('/app?test=1', { waitUntil: 'networkidle' });
  await expect.poll(async () => (await state(page))?.ready).toBe(true);
  await page.getByTestId('scene-countdown').click();
  await expect.poll(async () => (await state(page)).status).toBe('ready');
}

test('clicking outside clears both layer UI and keyboard focus without selecting a replacement', async ({ page }) => {
  await countdown(page);
  await expect.poll(() => selected(page)).toBe('');
  await page.getByTestId('layer-select-title').click();
  await page.getByTestId('canvas-layer-landscape-title').focus();
  await expect(page.locator('.canvas-selection-chrome')).toHaveCount(1);
  const before = await state(page);
  const beforeLayers = before.project.scenes.find((scene: any) => scene.id === before.project.selectedSceneId).appearance.layers;
  await page.locator('.preview-stage').click({ position: { x: 8, y: 8 } });
  await expect.poll(() => selected(page)).toBe('');
  await expect(page.locator('.canvas-selection-chrome')).toHaveCount(0);
  await expect(page.locator('.layer-properties-section')).toHaveCount(0);
  await expect(page.getByTestId('layer-select-title')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('ArrowRight');
  const after = await state(page);
  expect(after.project.scenes.find((scene: any) => scene.id === after.project.selectedSceneId).appearance.layers).toEqual(beforeLayers);
  expect(after.selectedLayerId).toBe('');

  await page.getByTestId('layer-select-title').click();
  await page.getByTestId('settings-trigger').click();
  await expect.poll(() => selected(page)).toBe('');
  await page.keyboard.press('Escape');
  await page.getByTestId('layer-select-title').click();
  await page.getByRole('button', { name: 'Remover camada', exact: true }).click();
  await expect.poll(() => selected(page)).toBe('');
  await expect(page.locator('.canvas-selection-chrome')).toHaveCount(0);
});

test('layer controls and portaled menus preserve selection; Escape and scene changes clear it', async ({ page }) => {
  await countdown(page);
  await page.getByTestId('layer-select-title').click();
  await page.getByTestId('layer-text').fill('Minha próxima aula');
  await expect.poll(() => selected(page)).toBe('title');
  const size = page.getByTestId('layer-font-size');
  const original = await size.inputValue();
  await size.fill('120');
  await size.press('Escape');
  await expect(size).toHaveValue(original);
  await expect.poll(() => selected(page)).toBe('title');
  await page.getByRole('button', { name: 'Selecionar formato vertical', exact: true }).click();
  await expect.poll(() => selected(page)).toBe('title');
  await expect(page.getByTestId('canvas-editor-portrait').locator('.canvas-selection-chrome')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toBe('');

  await page.getByTestId('scene-camera').click();
  await page.getByTestId('layer-select-camera').click();
  await selectValue(page, page.getByRole('combobox', { name: 'Ajuste da fonte' }), 'contain');
  await expect.poll(() => selected(page)).toBe('camera');
  await expect(page.getByRole('combobox', { name: 'Ajuste da fonte' })).toHaveAttribute('data-value', 'contain');
  // Keyboard scene changes must not carry a same-named layer into the next scene.
  await page.getByRole('button', { name: 'Selecionar formato horizontal', exact: true }).focus();
  await page.keyboard.press('5');
  await expect.poll(async () => (await state(page)).project.selectedSceneId).toBe('countdown');
  await expect.poll(() => selected(page)).toBe('');
});
