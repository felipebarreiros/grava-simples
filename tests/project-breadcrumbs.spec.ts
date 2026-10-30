import { test, expect, type Page } from "./fixtures/auth";

async function openStudio(page: Page) {
  await page.goto("/app?test=1&from=header", { waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => window.__recorderTest?.ready)).toBe(true);
  return page.evaluate(() => (window.__recorderTest as any).project);
}

test("the project breadcrumb opens two explicit actions and editing restores focus", async ({ page }) => {
  const project = await openStudio(page);
  const breadcrumb = page.getByRole("navigation", { name: "Navegação do projeto", exact: true });
  const trigger = breadcrumb.locator(".project-title-button");
  await expect(trigger).toContainText(project.name);
  await expect(breadcrumb.getByRole("tablist", { name: "Área do projeto", exact: true })).toBeVisible();

  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(2);
  await expect(menu.getByRole("menuitem", { name: "Copiar link do projeto", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Renomear projeto", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Renomear projeto", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.keyboard.press("End");
  const edit = menu.getByRole("menuitem", { name: "Renomear projeto", exact: true });
  await expect(edit).toBeFocused();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "Renomear projeto", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole("textbox", { name: "Nome do projeto", exact: true }).fill("Lançamento de vídeo");
  await editor.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(trigger).toHaveText("Lançamento de vídeo");
  await expect(trigger).toBeFocused();
});

test("copying a project link omits diagnostic parameters and reopens the saved project", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as any).__breadcrumbClipboard = copied;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => { copied.push(value); } },
    });
  });
  const project = await openStudio(page);
  const expected = new URL(page.url());
  expected.search = "";
  expected.hash = `project/${project.id}`;
  const trigger = page.locator(".project-title-button");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Copiar link do projeto", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__breadcrumbClipboard)).toEqual([expected.href]);
  await expect(page.getByRole("status").filter({ hasText: "Link copiado" })).toBeVisible();
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(page.getByRole("dialog", { name: "Renomear projeto", exact: true })).toHaveCount(0);

  await page.goto(expected.href, { waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => window.__recorderTest?.ready)).toBe(true);
  await expect(trigger).toHaveText(project.name);
  await expect(page.getByRole("tab", { name: "Estúdio", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(await page.evaluate(() => (window.__recorderTest as any).project.id)).toBe(project.id);
});

test("a failed clipboard write is announced and the project actions remain usable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Clipboard denied", "NotAllowedError"); } },
    });
  });
  await openStudio(page);
  const trigger = page.locator(".project-title-button");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Copiar link do projeto", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Não foi possível copiar" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Link copiado" })).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Renomear projeto", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Renomear projeto", exact: true })).toBeVisible();
});
