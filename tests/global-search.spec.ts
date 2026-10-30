import { test, expect, type Page } from "./fixtures/auth";

const state = (page: Page) => page.evaluate(() => (window as any).__recorderTest);

async function seedWorkspace(page: Page, includeScreen = false) {
  await page.route("**/search-storage-fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: "<!doctype html><html><body>Search storage fixture</body></html>",
  }));
  await page.goto("/search-storage-fixture");
  return page.evaluate(async (includeScreen) => {
    const projects = await import("/src/projects/store.ts");
    const { RecordingStore } = await import("/src/media/storage.ts");
    const first = projects.loadProjects()[0];
    first.name = "Apresentação do produto";
    first.scenes = first.scenes.slice(0, includeScreen ? 3 : 2);
    first.scenes[0].name = "Enquadramento principal";
    first.scenes[1].name = "Apresentação final";
    if (includeScreen) first.scenes[2].name = "Tela do lançamento";
    first.settings.resolution = "360";
    projects.saveProject(first);
    const second = projects.createProject("Curso de fotografia");
    second.scenes = second.scenes.slice(0, 1);
    second.settings.resolution = "360";
    projects.saveProject(second);

    // Persist an actual playable take through the same recording store as the app.
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff4000";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks: Blob[] = [];
    const stopped = new Promise<Blob>((resolve) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
    recorder.stop();
    const blob = await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const store = new RecordingStore("video/webm");
    await store.open();
    await store.write("landscape", blob);
    await store.write("portrait", blob);
    const files = await store.finalize(true);
    const makeFile = (orientation: "landscape" | "portrait") => ({
      orientation,
      blob: files[orientation],
      url: URL.createObjectURL(files[orientation]),
      fileName: `${orientation}.webm`,
      mimeType: "video/webm",
      size: files[orientation].size,
      durationMs: 250,
    });
    await projects.saveProjectTake(first.id, {
      id: store.id,
      startedAt: Date.now(),
      stoppedAt: Date.now() + 250,
      warnings: [],
      landscape: makeFile("landscape"),
      portrait: makeFile("portrait"),
    });
    projects.renameProjectTake(store.id, "Apresentação de abertura");
    return { firstId: first.id, secondId: second.id, takeId: store.id };
  }, includeScreen);
}

async function openApp(page: Page) {
  await page.goto("/app", { waitUntil: "networkidle" });
  await expect.poll(async () => (await state(page))?.ready).toBe(true);
}

test("global search groups projects, recordings and scenes, filters types, and handles missing results", async ({ page }) => {
  await seedWorkspace(page);
  await openApp(page);
  const originalUrl = page.url();
  await page.locator(".primary-nav").getByRole("button", { name: "Buscar", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const search = dialog.getByRole("combobox");
  await expect(search).toBeFocused();
  await search.fill("APRESENTACAO");
  await expect(dialog.getByRole("option")).toHaveCount(4);
  await expect(dialog.getByRole("group", { name: "Projetos", exact: true }).getByText("Apresentação do produto", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Gravações", exact: true }).getByText("Apresentação de abertura", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Cenas", exact: true }).getByText("Apresentação final", { exact: true })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Apresentação de abertura");
  await page.keyboard.press("ArrowUp");
  await expect(dialog.getByRole("option", { selected: true })).toContainText("Apresentação do produto");
  await expect(page).toHaveURL(originalUrl);
  await expect(page.locator(".projects-page")).toBeVisible();

  for (const [category, match, count] of [
    ["Projetos", "Apresentação do produto", 1],
    ["Gravações", "Apresentação de abertura", 1],
    ["Cenas", "Apresentação final", 2],
  ] as const) {
    await dialog.getByRole("tab", { name: new RegExp(`^${category}`) }).click();
    await expect(dialog.getByRole("option")).toHaveCount(count);
    await expect(dialog.getByRole("option").getByText(match, { exact: true })).toBeVisible();
  }
  const categories = dialog.getByRole("tablist", { name: "Tipos de resultado" });
  await categories.getByRole("tab", { name: /^Todos/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(categories.getByRole("tab", { name: /^Projetos/ })).toBeFocused();
  await expect(categories.getByRole("tab", { name: /^Projetos/ })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(categories.getByRole("tab", { name: /^Cenas/ })).toBeFocused();
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("Home");
  await expect(categories.getByRole("tab", { name: /^Todos/ })).toBeFocused();
  await expect(dialog.getByRole("option")).toHaveCount(4);
  await search.fill("nada-corresponde-a-esta-busca");
  await expect(dialog.getByRole("option")).toHaveCount(0);
  await expect(dialog.getByText(/Nenhum resultado/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".primary-nav").getByRole("button", { name: "Buscar", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Buscar em tudo", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveValue("");
  await page.mouse.click(5, 5);
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(originalUrl);
});

test("keyboard search opens projects and preserves explicit scenes across projects and the project grid", async ({ page, context }) => {
  const seeded = await seedWorkspace(page, true);
  await context.grantPermissions(["camera", "microphone"]);
  await page.addInitScript(() => {
    (window as any).__searchDisplayRequests = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      (window as any).__searchDisplayRequests++;
      throw new DOMException("A screen picker needs an explicit user action", "NotAllowedError");
    };
  });
  await openApp(page);
  await page.keyboard.press("Control+k");
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("Curso de fotografia");
  await dialog.getByRole("tab", { name: /^Projetos/ }).click();
  await dialog.getByRole("combobox").focus();
  await page.keyboard.press("ArrowDown");
  await expect(dialog.getByRole("option", { selected: true })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".project-title-button")).toHaveText("Curso de fotografia");
  await expect(page).toHaveURL(new RegExp(`#project/${seeded.secondId}$`));

  const originalUrl = page.url();
  await page.keyboard.press("Meta+k");
  dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(originalUrl);
  await dialog.getByRole("combobox").fill("Tela do lançamento");
  await expect(dialog.getByRole("option", { selected: true })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".project-title-button")).toHaveText("Apresentação do produto");
  await expect(page).toHaveURL(new RegExp(`#project/${seeded.firstId}$`));
  await expect.poll(async () => (await state(page)).status).toBe("ready");
  await expect(page.getByTestId("scene-screen")).toHaveAttribute("aria-pressed", "true");
  expect((await state(page)).config.layout).toBe("screen");
  expect(await page.evaluate(() => (window as any).__searchDisplayRequests)).toBe(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.locator(".primary-nav").getByRole("button", { name: "Todos os projetos", exact: true }).click();
  await page.keyboard.press("Control+k");
  dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("Apresentação final");
  await expect(dialog.getByRole("option", { selected: true })).toHaveAttribute("aria-disabled", "false");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await state(page)).status).toBe("ready");
  await expect(page.getByTestId("scene-camera-zoom")).toHaveAttribute("aria-pressed", "true");
});

test("opening a recording from search restores its detail page and returns to its project library", async ({ page }) => {
  const seeded = await seedWorkspace(page);
  await openApp(page);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").fill("Apresentação de abertura");
  await dialog.getByRole("option").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("recording-detail")).toBeVisible();
  await expect(page.getByTestId("recording-video-landscape")).toHaveAttribute("src", /^blob:/);
  await expect.poll(() => page.getByTestId("recording-video-landscape").evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(1);
  await expect(page).toHaveURL(new RegExp(`#project/${seeded.firstId}/recording/${seeded.takeId}$`));
  await expect(page.locator(".projects-page")).toBeHidden();
  await page.getByRole("button", { name: "Voltar para gravações", exact: true }).click();
  await expect(page.getByTestId("recording-detail")).toHaveCount(0);
  await expect(page.locator(".recordings-page")).toBeVisible();
  await expect(page.locator(".take-card")).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`#project/${seeded.firstId}$`));
});

test("opening and dismissing search keeps a live project camera mounted", async ({ page, context }) => {
  const seeded = await seedWorkspace(page);
  await context.grantPermissions(["camera", "microphone"]);
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    (window as any).__searchCaptureStreams = streams;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      streams.push(stream);
      return stream;
    };
  });
  await openApp(page);
  await page.getByTestId(`project-nav-${seeded.firstId}`).click();
  await expect.poll(async () => (await state(page)).status).toBe("ready");
  const url = page.url();
  const before = await page.evaluate(() => (window as any).__searchCaptureStreams.length);
  expect(before).toBeGreaterThan(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("combobox").fill("produto");
  await expect(page).toHaveURL(url);
  expect(await page.evaluate(() => (window as any).__searchCaptureStreams.flatMap((stream: MediaStream) => stream.getTracks()).every((track: MediaStreamTrack) => track.readyState === "live"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__searchCaptureStreams.length)).toBe(before);
  expect((await state(page)).status).toBe("ready");
  await expect(page).toHaveURL(url);
});
