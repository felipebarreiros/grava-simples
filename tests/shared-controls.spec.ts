import { test, expect, type Page } from "./fixtures/auth";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { selectValue } from "./helpers";

const state = (page: Page): Promise<any> => page.evaluate(() => window.__recorderTest);

async function countdownScene(page: Page) {
  await page.goto("/app?test=1", { waitUntil: "networkidle" });
  await expect.poll(async () => (await state(page))?.ready).toBe(true);
  await page.getByTestId("scene-countdown").click();
  await expect.poll(async () => (await state(page)).status).toBe("ready");
}

test("project tabs support keyboard navigation and keep the studio canvas mounted", async ({ page }) => {
  await countdownScene(page);
  const tabs = page.getByRole("tablist", { name: "Área do projeto" });
  const studio = tabs.getByRole("tab", { name: "Estúdio", exact: true });
  const recordings = tabs.getByRole("tab", { name: /^Gravações/ });
  const canvas = await page.getByTestId("landscape-preview").elementHandle();
  await studio.focus();
  await page.keyboard.press("ArrowRight");
  await expect(recordings).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel", { name: "Gravações", exact: true })).toBeVisible();
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  await expect(page.getByTestId("landscape-preview")).toBeHidden();
  await page.keyboard.press("Home");
  await expect(studio).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("landscape-preview")).toBeVisible();
  expect(await canvas!.evaluate((element) => element === document.querySelector('[data-testid="landscape-preview"]'))).toBe(true);
  await page.keyboard.press("End");
  await expect(recordings).toBeFocused();
  await expect(recordings).toHaveAttribute("aria-selected", "true");
  await studio.click();
  await expect.poll(async () => (await state(page)).countdown.running).toBe(false);

  // Long names must yield space to navigation and recording controls.
  await page.locator(".project-title-button").click();
  await page.getByRole("menuitem", { name: "Renomear projeto", exact: true }).click();
  await page.getByRole("textbox", { name: "Nome do projeto", exact: true }).fill("Projeto de lançamento com um nome bastante longo para a navegação");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator(".workspace-header").getByRole("tablist", { name: "Área do projeto" })).toBeVisible();
    const title = await page.locator(".project-title-button").boundingBox();
    const list = await tabs.boundingBox();
    const actions = await page.locator(".header-actions").boundingBox();
    const header = await page.locator(".workspace-header").boundingBox();
    expect(Math.abs((title!.y + title!.height / 2) - (list!.y + list!.height / 2))).toBeLessThan(2);
    expect(title!.width).toBeGreaterThanOrEqual(40);
    expect(title!.x + title!.width).toBeLessThanOrEqual(list!.x);
    expect(list!.x + list!.width).toBeLessThanOrEqual(actions!.x);
    expect(actions!.x + actions!.width).toBeLessThanOrEqual(header!.x + header!.width);
    await expect(page.getByTestId("start-recording")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("minute presets and custom duration update the real paused countdown and survive reload", async ({ page }) => {
  await countdownScene(page);
  await expect(page.getByTestId("countdown-duration")).toHaveText("5 minutos");
  for (const minutes of [1, 3, 5, 10, 15]) {
    await selectValue(page, "countdown-duration", String(minutes));
    await expect.poll(async () => (await state(page)).countdown).toEqual({ remainingSeconds: minutes * 60, running: false });
    await expect(page.getByTestId("countdown-custom-minutes")).toHaveCount(0);
  }
  await page.getByTestId("countdown-toggle").click();
  await expect.poll(async () => (await state(page)).countdown.running).toBe(true);
  await selectValue(page, "countdown-duration", "3");
  await expect.poll(async () => (await state(page)).countdown).toEqual({ remainingSeconds: 180, running: false });
  await selectValue(page, "countdown-duration", "custom");
  const custom = page.getByTestId("countdown-custom-minutes");
  await expect(custom).toHaveValue("3");
  await custom.fill("7");
  await custom.press("Enter");
  await expect.poll(async () => (await state(page)).countdown).toEqual({ remainingSeconds: 420, running: false });
  await page.reload({ waitUntil: "networkidle" });
  await expect.poll(async () => (await state(page))?.ready).toBe(true);
  await expect(page.getByTestId("countdown-duration")).toHaveAttribute("data-value", "custom");
  await expect(custom).toHaveValue("7");
  await expect.poll(async () => (await state(page)).countdown).toEqual({ remainingSeconds: 420, running: false });
  await custom.fill("0");
  await custom.press("Enter");
  await expect(page.getByTestId("countdown-toggle")).toBeDisabled();
  await expect.poll(async () => (await state(page)).countdown).toEqual({ remainingSeconds: 0, running: false });
  await selectValue(page, "countdown-duration", "5");
  await page.getByTestId("settings-trigger").click();
  await selectValue(page, "source-mode-select", "test");
  await selectValue(page, "resolution-select", "360");
  await page.getByTestId("prepare-inputs").click();
  await expect.poll(async () => (await state(page)).status).toBe("ready");
  await expect(page.getByTestId("prepare-inputs")).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.getByTestId("layer-select-background").click();
  await page.getByTestId("countdown-duration").click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await mkdir(resolve(".context/screenshots"), { recursive: true });
  await page.screenshot({ path: resolve(".context/screenshots/shared-controls-desktop.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("countdown-duration")).toBeFocused();
  await page.locator(".workspace-header").screenshot({ path: resolve(".context/screenshots/project-header-tabs.png") });
  await page.locator(".countdown-section").screenshot({ path: resolve(".context/screenshots/countdown-minutes.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tablist", { name: "Área do projeto" })).toBeVisible();
  await page.getByTestId("countdown-duration").scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(".context/screenshots/shared-controls-mobile.png"), fullPage: true });
});

test("layer menu and selection groups support keyboard use and keep a selected value", async ({ page }) => {
  await countdownScene(page);
  const add = page.getByTestId("add-source");
  await add.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Importar imagem ou vídeo", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await page.getByTestId("layer-select-title").click();
  const alignment = page.getByRole("radiogroup", { name: "Alinhamento do texto", exact: true });
  const left = alignment.getByRole("radio", { name: "Alinhar texto à esquerda", exact: true });
  await left.click();
  await expect(left).toBeChecked();
  await left.click();
  await expect(left).toBeChecked();
  await page.keyboard.press("ArrowRight");
  const center = alignment.getByRole("radio", { name: "Centralizar texto", exact: true });
  await expect(center).toBeFocused();
  await page.keyboard.press("Space");
  await expect(center).toBeChecked();
  const orientation = page.getByRole("radiogroup", { name: "Formato em edição", exact: true });
  await orientation.getByRole("radio", { name: "Editar formato vertical", exact: true }).click();
  await expect(orientation.getByRole("radio", { name: "Editar formato vertical", exact: true })).toBeChecked();
});
