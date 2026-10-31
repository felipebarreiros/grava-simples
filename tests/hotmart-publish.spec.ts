import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect } from "./fixtures/auth";
import { seedRecordingReview, openRecordingLibrary, openRecordingDetail } from "./fixtures/recordings";
import { selectValue } from "./helpers";

test.setTimeout(60000);

const course = { id: "course-1", name: "Escola de criação", membershipSlug: "escola" };
const membership = { id: "membership-1", slug: "escola", name: "Minha escola" };
const module = {
  id: "module-1", name: "Primeiros passos", order: 0,
  lessons: [{ id: "lesson-1", title: "Bem-vindos", published: true }],
};

async function openPublish(page: Parameters<typeof seedRecordingReview>[0]) {
  const recording = await seedRecordingReview(page);
  await openRecordingLibrary(page, recording.projectId);
  await openRecordingDetail(page);
  await page.getByRole("button", { name: "Exportar gravação", exact: true }).click();
  await page.getByRole("menuitem", { name: "Enviar para a Hotmart" }).click();
  await expect(page.getByTestId("hotmart-publish-dialog")).toBeVisible();
  return recording;
}

test("Hotmart connection is honestly unavailable until login is configured", async ({ page }) => {
  const writes: string[] = [];
  await page.route("**/api/hotmart*", async (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().method());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ configured: false, connected: false }) });
  });
  await openPublish(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/A conexão com a Hotmart ainda não está disponível/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Conectar minha conta Hotmart" })).toBeDisabled();
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  expect(writes).toEqual([]);
  await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("creator chooses course structure, edits lesson metadata and explicitly selects publication", async ({ page }) => {
  const writes: { action: string; [key: string]: unknown }[] = [];
  await page.route("**/api/hotmart*", async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe("Bearer fixture-session-token");
    const url = new URL(request.url());
    const body = request.method() === "GET" ? null : request.postDataJSON();
    const action = body?.action || url.searchParams.get("action");
    if (body) writes.push(body);
    let response: unknown;
    if (action === "status") response = { configured: true, connected: true, accountName: "Minha conta" };
    else if (action === "courses") response = [course];
    else if (action === "memberships") response = [membership];
    else if (action === "course") response = { course, modules: [module], classes: [{ id: "class-1", name: "Turma padrão", defaultClass: true }] };
    else if (action === "module-create") response = { id: "module-2", name: body.name, order: 1, lessons: [] };
    else if (action === "module-rename") response = { ...module, id: body.moduleId, name: body.name };
    else if (action === "module-reorder") response = [];
    else if (action === "course-create") response = { id: "course-2", name: body.input.name, membershipSlug: body.input.membershipSlug };
    else throw new Error(`Unexpected Hotmart request: ${action}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
  });
  await openPublish(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Enviar como rascunho" })).toBeEnabled();
  await expect(dialog.getByRole("textbox", { name: "Título da aula" })).toHaveValue("Uma ideia merece sair do papel");
  await expect(dialog.getByRole("textbox", { name: "Descrição da aula" })).toBeEmpty();
  await expect(dialog.getByRole("combobox", { name: "Visibilidade da aula" })).toHaveAttribute("data-value", "draft");
  await expect(dialog.getByRole("textbox", { name: "Nome do curso", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Enviar como rascunho" })).toHaveCSS("font-size", "12px");
  await expect(dialog.getByRole("button", { name: "Enviar como rascunho" })).toHaveCSS("background-color", "rgb(255, 64, 0)");
  await expect(dialog.getByRole("button", { name: "Enviar como rascunho" })).toHaveCSS("min-height", "36px");
  // Compare with a normal shared Input under the same application/modal cascade,
  // outside Hotmart's content subtree. This catches page-specific overrides
  // without treating a guessed token as the current application's appearance.
  const sharedInput = await dialog.evaluate((container) => {
    const reference = document.createElement("input");
    reference.className = "ui-input";
    reference.tabIndex = -1;
    reference.setAttribute("aria-hidden", "true");
    reference.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
    container.append(reference);
    try {
      const style = getComputedStyle(reference);
      return { background: style.backgroundColor, font: style.fontSize, radius: style.borderRadius, height: reference.getBoundingClientRect().height };
    } finally { reference.remove(); }
  });
  const titleField = dialog.getByRole("textbox", { name: "Título da aula" });
  await expect(titleField).toHaveCSS("font-size", sharedInput.font);
  await expect(titleField).toHaveCSS("background-color", sharedInput.background);
  await expect(titleField).toHaveCSS("border-radius", sharedInput.radius);
  expect((await titleField.boundingBox())!.height).toBeCloseTo(sharedInput.height, 0);
  await expect(dialog).toHaveCSS("background-color", "rgb(30, 30, 30)");
  await dialog.getByRole("textbox", { name: "Título da aula" }).fill("Uma boa captação de áudio");
  await dialog.getByRole("textbox", { name: "Descrição da aula" }).fill("Prepare seu microfone antes de começar a gravação.");
  await dialog.getByRole("button", { name: "Gerenciar módulos", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Módulos do curso", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Ver aulas de Primeiros passos" }).click();
  await expect(dialog.getByText("Bem-vindos", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Adicionar módulo", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Nome do módulo", exact: true }).fill("Áudio e voz");
  await dialog.getByRole("button", { name: "Criar módulo", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Selecionar módulo Áudio e voz", exact: true })).toBeVisible();
  await expect.poll(() => writes.filter((item) => item.action === "module-create").length).toBe(1);
  expect(writes[0]).toMatchObject({ action: "module-create", courseId: "course-1", name: "Áudio e voz" });
  await dialog.getByRole("button", { name: "Ações do módulo Áudio e voz" }).click();
  await page.getByRole("menuitem", { name: "Renomear módulo", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Novo nome do módulo" }).fill("Grave sua voz");
  await dialog.getByRole("button", { name: "Salvar nome", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Selecionar módulo Grave sua voz", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Ações do módulo Grave sua voz" }).click();
  await page.getByRole("menuitem", { name: "Mover para cima", exact: true }).click();
  await expect.poll(() => writes.filter((item) => item.action === "module-reorder").length).toBe(1);
  expect(writes.at(-1)).toMatchObject({ action: "module-reorder", moduleIds: ["module-2", "module-1"] });
  await dialog.getByRole("button", { name: "Voltar ao envio", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Módulo da aula" })).toHaveAttribute("data-value", "module-2");
  await expect(dialog.getByRole("textbox", { name: "Título da aula" })).toHaveValue("Uma boa captação de áudio");
  await expect(dialog.getByRole("textbox", { name: "Descrição da aula" })).toHaveValue("Prepare seu microfone antes de começar a gravação.");
  await dialog.getByRole("radio", { name: "Vertical", exact: true }).click();
  await selectValue(page, dialog.getByRole("combobox", { name: "Visibilidade da aula" }), "publish");
  await expect(dialog.getByRole("button", { name: "Enviar e publicar aula" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Enviar e publicar aula" })).toBeInViewport({ ratio: 1 });
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(640);
  expect(writes.map((item) => item.action)).toEqual(["module-create", "module-rename", "module-reorder"]);
  await mkdir(resolve(".context/screenshots"), { recursive: true });
  await page.screenshot({ path: resolve(".context/screenshots/hotmart-publish-desktop.png"), fullPage: true });
  await page.screenshot({ path: resolve(".context/hotmart-publish.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole("button", { name: "Enviar e publicar aula" })).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "Enviar e publicar aula" })).toHaveCSS("font-size", "12px");
  await page.screenshot({ path: resolve(".context/screenshots/hotmart-publish-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("new course keeps required description, price and members area visible before submission", async ({ page }) => {
  const submissions: any[] = [];
  await page.route("**/api/hotmart*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "GET" ? null : request.postDataJSON();
    const action = body?.action || url.searchParams.get("action");
    if (body) submissions.push(body);
    const response = action === "status" ? { configured: true, connected: true }
      : action === "courses" ? [course]
        : action === "memberships" ? [membership]
          : action === "course-create" ? { id: "course-2", name: body.input.name, membershipSlug: "escola" }
            : { course, modules: [module], classes: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
  });
  await openPublish(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Criar novo curso" }).click();
  await dialog.getByRole("textbox", { name: "Nome do curso", exact: true }).fill("Meu próximo curso");
  await dialog.getByRole("textbox", { name: "Preço (R$)", exact: true }).fill("2,00");
  await expect(dialog.getByRole("button", { name: "Criar curso", exact: true })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Descrição do curso", exact: true }).fill("Um curso para aprender a gravar aulas com clareza e confiança. ".repeat(4));
  await dialog.getByRole("textbox", { name: "Preço (R$)", exact: true }).fill("99,00");
  await selectValue(page, dialog.getByRole("combobox", { name: "Área de membros do novo curso" }), "escola");
  await expect(dialog.getByRole("button", { name: "Criar curso", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Criar curso", exact: true }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ action: "course-create", input: { name: "Meu próximo curso", price: 99, currency: "BRL", locale: "pt_BR", membershipSlug: "escola" } });
});

test("a first-time creator can explicitly create a members area before creating a course", async ({ page }) => {
  const writes: any[] = [];
  await page.route("**/api/hotmart*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "GET" ? null : request.postDataJSON();
    const action = body?.action || url.searchParams.get("action");
    if (body) writes.push(body);
    const response = action === "status" ? { configured: true, connected: true }
      : action === "courses" || action === "memberships" ? []
        : action === "membership-create" ? { id: "first-school", name: body.name, slug: body.slug }
          : { course, modules: [], classes: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
  });
  await openPublish(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Criar novo curso" }).click();
  await dialog.getByRole("button", { name: "Criar área de membros", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Nome da área de membros", exact: true }).fill("Escola do criador");
  await dialog.getByRole("textbox", { name: "Identificador da área", exact: true }).fill("escola-do-criador");
  await dialog.getByRole("button", { name: "Criar e selecionar área" }).click();
  await expect(dialog.getByRole("combobox", { name: "Área de membros do novo curso" })).toHaveAttribute("data-value", "escola-do-criador");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({ action: "membership-create", name: "Escola do criador", slug: "escola-do-criador" });
});

test("same-tab Hotmart login returns to the recording and reopens the publishing dialog", async ({ page }) => {
  let connected = false;
  const connectCalls: any[] = [];
  await page.route("**/api/hotmart*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.method() === "GET" ? null : request.postDataJSON();
    const action = body?.action || url.searchParams.get("action");
    let response: unknown;
    if (action === "status") response = { configured: true, connected, accountName: "Minha conta" };
    else if (action === "connect") {
      connectCalls.push(body);
      connected = true;
      const returned = new URL(body.returnTo, url.origin);
      returned.searchParams.set("hotmart", "connected");
      response = { url: returned.href };
    }
    else if (action === "courses") response = [course];
    else if (action === "memberships") response = [membership];
    else response = { course, modules: [module], classes: [] };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
  });
  const saved = await openPublish(page);
  await page.getByRole("button", { name: "Conectar minha conta Hotmart" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Enviar como rascunho" })).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`recording/${saved.takeId}`));
  expect(connectCalls).toHaveLength(1);
  expect(connectCalls[0].returnTo).toContain(`recording/${saved.takeId}`);
});

async function mockPublisher(
  page: Parameters<typeof seedRecordingReview>[0],
  options: { rejectFirstSign?: boolean; slowFirstUpload?: boolean } = {},
) {
  // Only replace media preparation: the real browser client must still execute
  // authenticated metadata requests, direct part PUTs, and lesson creation.
  await page.route("**/src/media/compatibleExport.ts*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `export async function prepareCompatibleDownload(file, progress) {
      progress?.({ phase: 'converting', progress: 1 });
      return { ...file, url: URL.createObjectURL(file.blob), fileName: file.orientation + '-compartilhar.mp4', mimeType: 'video/mp4;codecs=avc1,mp4a.40.2' };
    }`,
  }));
  const calls: any[] = [];
  const job = { jobId: "bfb7267a-6e87-4f74-9598-d3c1134736f0", status: "uploading", partSize: 6 * 1024 * 1024, partCount: 1 };
  let signCount = 0, uploads = 0;
  let uploadIntent: any;
  await page.route("**/hotmart-fixture-s3*", async (route) => {
    expect(route.request().method()).toBe("PUT");
    uploads++;
    if (options.slowFirstUpload && uploads === 1) await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ headers: { ETag: '"fixture-part-etag"' }, body: "" }).catch(() => {});
  });
  await page.route("**/api/hotmart*", async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe("Bearer fixture-session-token");
    const url = new URL(request.url());
    const body = request.method() === "GET" ? null : request.postDataJSON();
    const action = body?.action || url.searchParams.get("action");
    calls.push({ action, ...body });
    let response: unknown;
    if (action === "status") response = { configured: true, connected: true, accountName: "Minha conta" };
    else if (action === "courses") response = [course];
    else if (action === "memberships") response = [membership];
    else if (action === "course") response = { course, modules: [module], classes: [] };
    else if (action === "upload-start") { uploadIntent = body; response = job; }
    else if (action === "upload-status") response = job;
    else if (action === "upload-sign") {
      signCount++;
      if (options.rejectFirstSign && signCount === 1) {
        await route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "Não foi possível preparar o envio. Tente novamente." }) });
        return;
      }
      response = { url: `${url.origin}/hotmart-fixture-s3?partNumber=1`, headers: {} };
    }
    else if (action === "upload-complete") { job.status = "ready"; response = job; }
    else if (action === "lesson-create") response = { lessonId: "new-lesson", url: "https://app.hotmart.com/membership/list", published: uploadIntent.publish };
    else throw new Error(`Unexpected publisher request ${action}`);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
  });
  return { calls, uploads: () => uploads };
}

test("publish pipeline sends selected MP4 and metadata, then confirms a private draft without downloading", async ({ page }) => {
  const { calls, uploads } = await mockPublisher(page);
  let downloads = 0;
  page.on("download", () => downloads++);
  const saved = await openPublish(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Título da aula" }).fill("Prepare sua primeira aula");
  await dialog.getByRole("textbox", { name: "Descrição da aula" }).fill("Uma descrição escrita pelo criador.");
  await dialog.getByRole("radio", { name: "Vertical", exact: true }).click();
  await dialog.getByRole("button", { name: "Enviar como rascunho" }).click();
  await expect(dialog.getByText("Sua aula foi salva como rascunho", { exact: true })).toBeVisible();
  expect(calls.find((call) => call.action === "upload-start")).toMatchObject({
    courseId: "course-1", moduleId: "module-1", recordingId: saved.takeId,
    title: "Prepare sua primeira aula", description: "Uma descrição escrita pelo criador.",
    fileName: "portrait-compartilhar.mp4", fileType: "video/mp4", publish: false,
  });
  expect(calls.filter((call) => call.action === "lesson-create")).toHaveLength(1);
  expect(uploads()).toBe(1);
  expect(downloads).toBe(0);
  await expect(dialog.getByRole("link", { name: "Abrir na Hotmart" })).toHaveAttribute("href", "https://app.hotmart.com/membership/list");
});

test("publication remains an explicit choice in the shared visibility control", async ({ page }) => {
  const { calls } = await mockPublisher(page);
  await openPublish(page);
  const dialog = page.getByRole("dialog");
  const visibility = dialog.getByRole("combobox", { name: "Visibilidade da aula" });
  await expect(visibility).toHaveAttribute("data-value", "draft");
  await selectValue(page, visibility, "publish");
  await dialog.getByRole("button", { name: "Enviar e publicar aula", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Sua aula está publicada", exact: true })).toBeVisible();
  expect(calls.find((call) => call.action === "upload-start")).toMatchObject({ publish: true });
  expect(calls.filter((call) => call.action === "lesson-create")).toHaveLength(1);
});

test("a failed upload can resume without creating a second upload job", async ({ page }) => {
  const { calls } = await mockPublisher(page, { rejectFirstSign: true });
  await openPublish(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Enviar como rascunho" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Não foi possível preparar o envio");
  await dialog.getByRole("button", { name: "Enviar como rascunho" }).click();
  await expect(dialog.getByText("Sua aula foi salva como rascunho", { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.action === "upload-start")).toHaveLength(1);
  expect(calls.filter((call) => call.action === "upload-status")).toHaveLength(1);
  expect(calls.filter((call) => call.action === "lesson-create")).toHaveLength(1);
});

test("interrupting the transfer keeps the draft details and resumes after explicit retry", async ({ page }) => {
  const { calls, uploads } = await mockPublisher(page, { slowFirstUpload: true });
  await openPublish(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Enviar como rascunho" }).click();
  await expect.poll(uploads).toBe(1);
  await dialog.getByRole("button", { name: "Interromper envio" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Envio interrompido");
  expect(calls.some((call) => call.action === "lesson-create")).toBe(false);
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await page.getByRole("button", { name: "Exportar gravação", exact: true }).click();
  await page.getByRole("menuitem", { name: "Enviar para a Hotmart" }).click();
  await expect(dialog.getByRole("textbox", { name: "Título da aula" })).toHaveValue("Uma ideia merece sair do papel");
  await dialog.getByRole("button", { name: "Enviar como rascunho" }).click();
  await expect(dialog.getByText("Sua aula foi salva como rascunho", { exact: true })).toBeVisible();
  expect(calls.filter((call) => call.action === "upload-start")).toHaveLength(1);
  expect(calls.filter((call) => call.action === "lesson-create")).toHaveLength(1);
});
