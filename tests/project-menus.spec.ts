import { test, expect, type Page } from "./fixtures/auth";

async function openStudio(page: Page) {
  await page.goto("/app?test=1", { waitUntil: "networkidle" });
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest?.ready)).toBe(true);
  return page.evaluate(() => (window as any).__recorderTest.project);
}

test("project actions use keyboard menus and restore focus after editing or dismissing", async ({ page }) => {
  const project = await openStudio(page);
  const trigger = page.locator(".project-nav").getByRole("button", { name: `Opções do projeto ${project.name}`, exact: true });
  await trigger.click();
  const menu = page.getByRole("menu", { name: `Ações do projeto ${project.name}`, exact: true });
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Excluir projeto", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Renomear projeto", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Renomear projeto", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();

  const projectButton = page.getByTestId(`project-nav-${project.id}`);
  await projectButton.click({ button: "right" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Renomear projeto", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Renomear projeto", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(projectButton).toBeFocused();

  await page.locator(".primary-nav").getByRole("button", { name: "Todos os projetos", exact: true }).click();
  const card = page.getByTestId("project-card").filter({ hasText: project.name });
  await card.getByRole("button", { name: `Opções do projeto ${project.name}`, exact: true }).click();
  await menu.getByRole("menuitem", { name: "Renomear projeto", exact: true }).click();
  await page.getByRole("textbox", { name: "Nome do projeto", exact: true }).fill("Projeto renomeado");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId("project-card").filter({ hasText: "Projeto renomeado" })).toBeVisible();
});

test("project deletion requires an accessible confirmation and cancel preserves the project", async ({ page }) => {
  const project = await openStudio(page);
  const trigger = page.locator(".project-nav").getByRole("button", { name: `Opções do projeto ${project.name}`, exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: "Renomear projeto", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Renomear projeto", exact: true });
  const deleteButton = editor.getByRole("button", { name: "Excluir projeto", exact: true });
  await deleteButton.click();
  const confirmation = page.getByRole("alertdialog", { name: "Excluir projeto?", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(project.name);
  await expect(confirmation.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).not.toBeVisible();
  await expect(editor).toBeVisible();
  await expect(deleteButton).toBeFocused();
  await deleteButton.click();
  await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByTestId(`project-nav-${project.id}`)).toBeVisible();
  await page.keyboard.press("Escape");
  await trigger.click();
  await page.getByRole("menuitem", { name: "Excluir projeto", exact: true }).click();
  await page.keyboard.press("3");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Busca global", exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__recorderTest.project.selectedSceneId)).toBe(project.selectedSceneId);
  await confirmation.getByRole("button", { name: "Excluir projeto", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.getByTestId(`project-nav-${project.id}`)).toHaveCount(0);
});

test("recording deletion uses the same confirmation and preserves recordings when cancelled", async ({ page }) => {
  const project = await openStudio(page);
  await page.evaluate(async (projectId) => {
    const projects = await import("/src/projects/store.ts");
    const storage = await import("/src/media/storage.ts");
    const recording = new storage.RecordingStore("video/mp4");
    await recording.open();
    await recording.write("landscape", new Blob(["landscape"]));
    await recording.write("portrait", new Blob(["portrait"]));
    const files = await recording.finalize(true);
    const makeFile = (orientation: "landscape" | "portrait") => ({ orientation, blob: files[orientation], url: URL.createObjectURL(files[orientation]), fileName: `${orientation}.mp4`, mimeType: "video/mp4", size: files[orientation].size, durationMs: 1000 });
    const take = await projects.saveProjectTake(projectId, { id: recording.id, landscape: makeFile("landscape"), portrait: makeFile("portrait"), startedAt: 1000, stoppedAt: 2000, warnings: [] });
    projects.renameProjectTake(take.id, "Minha gravação");
  }, project.id);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("tab", { name: /^Gravações/ }).click();
  await page.getByRole("button", { name: "Editar Minha gravação", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Editar gravação", exact: true });
  await editor.getByRole("button", { name: "Excluir", exact: true }).click();
  const confirmation = page.getByRole("alertdialog", { name: "Excluir gravação?", exact: true });
  await expect(confirmation).toContainText("Minha gravação");
  await confirmation.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(editor).toBeVisible();
  await editor.getByRole("button", { name: "Excluir", exact: true }).click();
  await confirmation.getByRole("button", { name: "Excluir gravação", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Editar Minha gravação", exact: true })).toHaveCount(0);
});
