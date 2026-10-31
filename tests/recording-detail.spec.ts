import { test, expect } from "./fixtures/auth";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  seedRecordingReview as seed,
  openRecordingLibrary as openLibrary,
  openRecordingDetail as openDetail,
} from "./fixtures/recordings";

const generatedTranscript = {
  version: 1, origin: "automatic", provider: "assemblyai", sourceName: "Transcrição automática", importedAt: 1, updatedAt: 1,
  cues: [
    { id: "cue-1", start: 0, end: 2, text: "Uma ideia merece sair do papel." },
    { id: "cue-2", start: 2, end: 4, text: "A criação começa com uma boa história." },
    { id: "cue-3", start: 4, end: 6, text: "Vamos gravar o próximo capítulo." },
  ],
};
async function saveGeneratedTranscript(page: Parameters<typeof seed>[0], id: string) {
  await page.evaluate(async ({ id, transcript }) => {
    (await import('/src/recordings/transcript.ts')).saveTranscript(id, transcript as any);
  }, { id, transcript: generatedTranscript });
  await page.reload({ waitUntil: "networkidle" });
}

test("recording page shows generated captions, seeks, corrects, bookmarks and restores its direct link", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const saved = await seed(page);
  await openLibrary(page, saved.projectId);
  await mkdir(resolve(".context/screenshots"), { recursive: true });
  await page.screenshot({
    path: resolve(".context/screenshots/recordings-library.png"),
    fullPage: true,
  });
  await openDetail(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("Transcrição indisponível no momento.", {
      exact: false,
    }),
  ).toBeVisible();
  const preview = await page.locator(".recording-video-pane").boundingBox();
  const inspector = await page.locator(".recording-transcript-pane").boundingBox();
  expect(preview!.x + preview!.width).toBeLessThanOrEqual(inspector!.x);
  expect(preview!.width).toBeGreaterThan(inspector!.width);
  await expect(page.getByRole("button", { name: "Exportar gravação" })).toHaveCSS("font-size", "12px");
  await expect(page.getByRole("button", { name: "Exportar gravação" })).toHaveCSS("background-color", "rgb(255, 64, 0)");
  await expect(page.getByRole("button", { name: "Exportar gravação" })).toHaveCSS("min-height", "36px");
  await expect(page.locator(".recording-transcript-pane")).toHaveCSS("background-color", "rgb(30, 30, 30)");
  await page.screenshot({
    path: resolve(".context/screenshots/recording-detail-empty.png"),
    fullPage: true,
  });
  await saveGeneratedTranscript(page, saved.takeId);
  await expect(page.getByTestId("transcript-cue")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Ir para 00:02", exact: true })
    .click();
  await expect
    .poll(() =>
      page
        .getByTestId("recording-video-landscape")
        .evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeCloseTo(2, 1);
  await expect(page.locator(".transcript-cue.is-current")).toContainText(
    "A criação",
  );
  await page
    .getByRole("textbox", { name: "Buscar na transcrição" })
    .fill("CRIACAO");
  await expect(page.getByTestId("transcript-cue")).toHaveCount(1);
  await page.getByRole("button", { name: "Corrigir trecho em 00:02" }).click();
  await page
    .getByRole("textbox", { name: "Corrigir texto do trecho" })
    .fill("A criação começa com uma história que vale contar.");
  await page.getByRole("button", { name: "Salvar correção" }).click();
  await expect(page.getByTestId("transcript-cue")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Marcar momento", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Nota do marcador" })
    .fill("Uma boa abertura para o próximo vídeo.");
  await page
    .getByRole("button", { name: "Adicionar marcador", exact: true })
    .click();
  await expect(page.locator(".recording-marker-list")).toContainText(
    "Uma boa abertura",
  );
  const url = page.url();
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("recording-detail")).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId("transcript-cue")).toHaveCount(3);
  await expect(page.getByTestId("transcript-cue").nth(1)).toContainText(
    "uma história que vale contar",
  );
  await page.getByRole("tab", { name: /^Marcadores/ }).click();
  await expect(page.locator(".recording-marker-list")).toContainText(
    "Uma boa abertura",
  );
  await page.getByRole("tab", { name: "Transcrição", exact: true }).click();
  await page
    .getByRole("button", { name: "Ir para 00:02", exact: true })
    .click();
  await page.screenshot({
    path: resolve(".context/screenshots/recording-detail-transcript.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Voltar para gravações" }).click();
  await expect(page.locator(".take-card")).toBeVisible();
  await openDetail(page);
  await page.goBack();
  await expect(page.locator(".take-card")).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId("recording-detail")).toBeVisible();
  await page
    .getByRole("tablist", { name: "Área do projeto" })
    .getByRole("tab", { name: /^Gravações/ })
    .click();
  await expect(page.locator(".take-card")).toBeVisible();
  await openDetail(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobilePreview = await page.locator(".recording-video-pane").boundingBox();
  const mobileInspector = await page.locator(".recording-transcript-pane").boundingBox();
  expect(mobilePreview!.y + mobilePreview!.height).toBeLessThanOrEqual(mobileInspector!.y);
  await expect(page.getByRole("button", { name: "Exportar gravação" })).toHaveCSS("font-size", "12px");
  await page.screenshot({
    path: resolve(".context/screenshots/recording-detail-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("format switches preserve playhead and generated captions export with source timing", async ({
  page,
}) => {
  const saved = await seed(page);
  await openLibrary(page, saved.projectId);
  await openDetail(page);
  await saveGeneratedTranscript(page, saved.takeId);
  await page
    .getByRole("button", { name: "Ir para 00:04", exact: true })
    .click();
  await page.getByRole("radio", { name: "Vertical", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByTestId("recording-video-portrait")
        .evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeCloseTo(4, 1);
  await page
    .getByRole("button", { name: "Reproduzir vídeo", exact: true })
    .last()
    .click();
  await expect
    .poll(() =>
      page
        .getByTestId("recording-video-portrait")
        .evaluate((video: HTMLVideoElement) => video.paused),
    )
    .toBe(false);
  await page.getByRole("radio", { name: "Horizontal", exact: true }).click();
  await expect
    .poll(() =>
      page
        .getByTestId("recording-video-landscape")
        .evaluate((video: HTMLVideoElement) => video.paused),
    )
    .toBe(false);
  await page.getByRole("button", { name: "Pausar vídeo", exact: true }).click();
  await page.getByRole("button", { name: "Opções da transcrição" }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Baixar legendas (.srt)" }).click();
  const download = await downloadEvent;
  const path = await download.path();
  const exported = await readFile(path!, "utf8");
  expect(exported).toContain("00:00:02,000 --> 00:00:04,000");
  expect(exported).toContain("A criação começa");
  await expect(page.getByTestId("transcript-file-input")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Importar transcrição/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Exportar gravação" }).click();
  const originalEvent = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Original horizontal" }).click();
  const original = await originalEvent;
  expect((await readFile((await original.path())!)).length).toBe(saved.bytes);
  await page.getByRole("button", { name: "Exportar gravação" }).click();
  const compatibleEvent = page.waitForEvent("download");
  await page
    .getByRole("menuitem", { name: "Baixar horizontal em MP4" })
    .click();
  const compatible = await compatibleEvent;
  expect(compatible.suggestedFilename()).toMatch(/-compartilhar\.mp4$/);
});

test("deleting the open recording closes its page and removes local transcript and markers", async ({
  page,
}) => {
  const saved = await seed(page);
  await openLibrary(page, saved.projectId);
  await openDetail(page);
  await saveGeneratedTranscript(page, saved.takeId);
  await page
    .getByRole("button", { name: "Marcar momento", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Nota do marcador" }).fill("Revisar");
  await page
    .getByRole("button", { name: "Adicionar marcador", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Renomear gravação", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Excluir", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Excluir gravação", exact: true })
    .click();
  await expect(page.getByTestId("recording-detail")).toHaveCount(0);
  await expect(page.getByText("Sua primeira gravação vem aí.")).toBeVisible();
  const local = await page.evaluate(
    async (id) => ({
      transcript: (
        await import("/src/recordings/transcript.ts")
      ).loadTranscript(id),
      markers: (await import("/src/recordings/review.ts")).loadReview(id)
        .markers,
    }),
    saved.takeId,
  );
  expect(local.transcript).toBeNull();
  expect(local.markers).toEqual([]);
});

test("recording direct links play without capture permissions or a capture engine and missing links return to the library", async ({
  page,
}) => {
  const saved = await seed(page);
  await page.addInitScript(() => {
    (window as any).__recordingCaptureRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      (window as any).__recordingCaptureRequests++;
      throw new DOMException(
        "No capture in recording review",
        "NotAllowedError",
      );
    };
  });
  await page.route("**/engine/obs-core.wasm", (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  await page.goto(
    `/app?test=1#project/${saved.projectId}/recording/${saved.takeId}`,
    { waitUntil: "networkidle" },
  );
  await expect(page.getByTestId("recording-detail")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("recording-video-landscape")
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  expect(
    await page.evaluate(() => (window as any).__recordingCaptureRequests),
  ).toBe(0);
  await page.evaluate(async (id) => {
    await (await import("/src/media/storage.ts")).deleteRecordingFiles(id);
  }, saved.takeId);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("recording-detail")).toHaveCount(0);
  await expect(page.locator(".take-card")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#project/${saved.projectId}$`));
  await page.goto(`/app?test=1#project/${saved.projectId}/recording/missing`, {
    waitUntil: "networkidle",
  });
  await expect(page.getByTestId("recording-detail")).toHaveCount(0);
  await expect(page.locator(".take-card")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#project/${saved.projectId}$`));
});
