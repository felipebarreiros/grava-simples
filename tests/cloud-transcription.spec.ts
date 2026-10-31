import { test, expect } from "./fixtures/auth";
import {
  seedRecordingReview,
  openRecordingLibrary,
  openRecordingDetail,
} from "./fixtures/recordings";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const automatic = {
  version: 1,
  origin: "automatic",
  provider: "assemblyai",
  sourceName: "Transcrição automática",
  importedAt: 1,
  updatedAt: 1,
  language: "pt",
  cues: [
    { id: "cue-1", start: 0.2, end: 1.9, text: "Olá, criadores." },
    { id: "cue-2", start: 2.5, end: 4.4, text: "Vamos começar." },
  ],
  words: [
    { id: "word-1", text: "Olá,", start: 0.2, end: 0.8 },
    { id: "word-2", text: "criadores.", start: 1.2, end: 1.9 },
    { id: "word-3", text: "Vamos", start: 2.5, end: 3 },
    { id: "word-4", text: "começar.", start: 3.4, end: 4.4 },
  ],
};
const idle = {
  configured: true,
  status: "idle",
  maxUploadBytes: 512 * 1024 * 1024,
  maxAudioSeconds: 7200,
};

/** Replace the cloud transport only in this test browser; the server suite verifies real signed JWTs. */
async function mockBlobClient(
  page: Parameters<typeof seedRecordingReview>[0],
  paused = false,
) {
  await page.route(/\/@vercel_blob_client\.js(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    export async function upload(path, body, options) {
      const response = await fetch(options.handleUploadUrl, {
        method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, clientPayload: options.clientPayload, size: body.size, access: options.access })
      });
      if (!response.ok) throw new Error('Falha no envio de teste');
      options.onUploadProgress?.({ loaded: body.size / 2, total: body.size, percentage: 50 });
      ${paused ? "await new Promise((resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));" : ""}
      return { url: 'https://fixture.private.blob.vercel-storage.com/' + path, pathname: path };
    }
  `,
    }),
  );
}

test("authenticated cloud job uploads once, survives navigation, seeks actual words and preserves corrections on reload", async ({
  page,
}) => {
  const saved = await seedRecordingReview(page);
  await mockBlobClient(page);
  let stage = "idle";
  let cloudResult = automatic;
  const grants: any[] = [],
    submissions: any[] = [];
  let deletions = 0;
  await page.route("**/api/transcription-upload", async (route) => {
    expect(route.request().headers().authorization).toBe(
      "Bearer fixture-session-token",
    );
    grants.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/transcriptions*", async (route) => {
    const request = route.request();
    expect(request.headers().authorization).toBe(
      "Bearer fixture-session-token",
    );
    if (request.method() === "POST") {
      submissions.push(request.postDataJSON());
      stage = "processing";
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          ...idle,
          status: "queued",
          jobId: `provider-${submissions.length}`,
        }),
      });
    } else if (request.method() === "DELETE") {
      deletions++;
      stage = "idle";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(idle),
      });
    } else
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ...idle,
          status: stage,
          ...(stage !== "idle"
            ? { jobId: `provider-${submissions.length}` }
            : {}),
          ...(stage === "completed" ? { transcript: cloudResult } : {}),
        }),
      });
  });
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("transcript-file-input")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Importar transcrição/ })).toHaveCount(0);
  await expect(
    page.getByText("Transcrevendo sua gravação…", { exact: true }),
  ).toBeVisible();
  expect(grants).toHaveLength(1);
  expect(submissions).toHaveLength(1);
  expect(grants[0].access).toBe("private");
  expect(grants[0].path).toMatch(
    new RegExp(
      `^transcriptions/user_fixture/${saved.takeId}/[a-z0-9-]+\\.mp4$`,
    ),
  );
  expect(submissions[0].recordingId).toBe(saved.takeId);
  await page.getByRole("button", { name: "Voltar para gravações" }).click();
  expect(deletions).toBe(0);
  stage = "completed";
  await openRecordingDetail(page);
  await expect(
    page.getByRole("button", { name: "Ir para palavra: criadores." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Ir para palavra: criadores." })
    .click();
  await expect
    .poll(() =>
      page
        .getByTestId("recording-video-landscape")
        .evaluate((video: HTMLVideoElement) => video.currentTime),
    )
    .toBeCloseTo(1.2, 2);
  await mkdir(resolve(".context/screenshots"), { recursive: true });
  await page.screenshot({
    path: resolve(".context/screenshots/cloud-transcription-words.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Corrigir trecho em 00:00" }).click();
  await page
    .getByRole("textbox", { name: "Corrigir texto do trecho" })
    .fill("Olá, comunidade!");
  await page
    .getByRole("button", { name: "Salvar correção", exact: true })
    .click();
  await page.reload({ waitUntil: "networkidle" });
  await expect(
    page.getByRole("button", { name: "Ir para trecho: Olá, comunidade!" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ir para palavra: Vamos" }),
  ).toBeVisible();
  expect(submissions).toHaveLength(1);
  await page.getByRole("button", { name: "Opções da transcrição" }).click();
  await page
    .getByRole("menuitem", { name: "Remover transcrição", exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Remover transcrição", exact: true })
    .click();
  await expect(page.getByTestId("transcript-cue")).toHaveCount(0);
  expect(deletions).toBe(1);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("transcript-cue")).toHaveCount(0);
});

test("cancelled upload cleans the cloud grant and a rate limit cannot produce an invented transcript", async ({
  page,
}) => {
  const saved = await seedRecordingReview(page);
  await mockBlobClient(page, true);
  let limited = false,
    deletions = 0,
    uploads = 0;
  await page.route("**/api/transcription-upload", async (route) => {
    uploads++;
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/transcriptions*", async (route) => {
    if (route.request().method() === "DELETE") deletions++;
    await route.fulfill({
      status: limited ? 429 : 200,
      contentType: "application/json",
      headers: limited ? { "Retry-After": "60" } : {},
      body: JSON.stringify(limited ? { error: "Quota" } : idle),
    });
  });
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect(
    page.getByText("Enviando gravação · 50%", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Cancelar transcrição", exact: true })
    .click();
  await expect.poll(() => deletions).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("transcript-cue")).toHaveCount(0);
  await expect(page.getByTestId("transcription-status")).toContainText("Transcrição cancelada.");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("transcription-status")).toContainText("Transcrição cancelada.");
  expect(uploads).toBe(1);
  limited = true;
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByText(/Limite de transcrições atingido/)).toBeVisible();
  expect(uploads).toBe(1);
  await expect(page.getByTestId("transcript-cue")).toHaveCount(0);
});

test("recordings above two hours expose the limit before an upload starts", async ({
  page,
}) => {
  const saved = await seedRecordingReview(page);
  await page.evaluate(async (id) => {
    const { WORKSPACE_STORAGE_KEY: key } = await import('/src/projects/keys.ts');
    const workspace = JSON.parse(localStorage.getItem(key)!);
    workspace.takes.find((take: any) => take.id === id).durationMs =
      7201 * 1000;
    localStorage.setItem(key, JSON.stringify(workspace));
  }, saved.takeId);
  await page.route("**/api/transcriptions*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(idle),
    }),
  );
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toHaveCount(0);
  await expect(
    page.getByText(
      /excede o limite de duas horas para transcrição/,
    ),
  ).toBeVisible();
});

test("cancellation invalidates a late completed poll instead of restoring deleted speech", async ({
  page,
}) => {
  const saved = await seedRecordingReview(page);
  let polls = 0,
    cancelled = false,
    pending = false;
  let releasePoll: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  await page.route("**/api/transcriptions*", async (route) => {
    if (route.request().method() === "DELETE") {
      cancelled = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(idle),
      });
    } else {
      polls++;
      if (polls === 2) {
        pending = true;
        await held;
        await route
          .fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ...idle,
              status: "completed",
              jobId: "provider-1",
              transcript: automatic,
            }),
          })
          .catch(() => {});
      } else
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            ...idle,
            status: cancelled ? "idle" : "processing",
            jobId: "provider-1",
          }),
        });
    }
  });
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect(
    page.getByRole("button", { name: "Cancelar transcrição" }),
  ).toBeVisible();
  await expect.poll(() => pending).toBe(true);
  await page.getByRole("button", { name: "Cancelar transcrição" }).click();
  await expect.poll(() => cancelled).toBe(true);
  releasePoll();
  await expect(page.getByTestId("transcription-status")).toContainText("Transcrição cancelada.");
  await expect(page.getByRole("button", { name: "Tentar novamente", exact: true })).toBeEnabled();
  await expect(page.getByTestId("transcript-cue")).toHaveCount(0);
  const stored = await page.evaluate(
    async (id) =>
      (await import("/src/recordings/transcript.ts")).loadTranscript(id),
    saved.takeId,
  );
  expect(stored).toBeNull();
});

test("an unconfigured service shows a concise empty state without imports or automatic uploads", async ({ page }) => {
  const saved = await seedRecordingReview(page);
  let uploads = 0;
  await page.route('**/api/transcription-upload', route => { uploads++; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }); });
  await page.route('**/api/transcriptions*', route => route.fulfill({ json: { ...idle, configured: false } }));
  await page.goto(`/app?test=1#project/${saved.projectId}/recording/${saved.takeId}`);
  await expect(page.getByTestId('recording-detail')).toBeVisible();
  await expect(page.getByTestId('transcription-status')).toHaveText('Transcrição indisponível no momento.Verificar novamente');
  await expect(page.getByTestId('transcript-file-input')).toHaveCount(0);
  await expect(page.getByText(/Importar transcrição|SRT ou VTT|Cada palavra,|Dois formatos salvos|DO VÍDEO PARA AS PALAVRAS/)).toHaveCount(0);
  expect(uploads).toBe(0);
});

test("an initially unavailable service is checked again and starts the queued job when it becomes ready", async ({ page }) => {
  const saved = await seedRecordingReview(page);
  await mockBlobClient(page);
  let reads = 0;
  let stage: "idle" | "processing" = "idle";
  await page.route("**/api/transcription-upload", route =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/transcriptions*", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      stage = "processing";
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ...idle, status: "queued", jobId: "retry-job" }),
      });
    }
    reads++;
    if (reads === 1)
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...idle, configured: false }),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...idle, status: stage, ...(stage === "processing" ? { jobId: "retry-job" } : {}) }),
    });
  });
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect(page.getByTestId("transcription-status")).toHaveText(
    "Transcrição indisponível no momento.Verificar novamente",
  );
  await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByText(/Na fila para transcrição…|Transcrevendo sua gravação…/)).toBeVisible();
  await expect(page.getByTestId("transcript-cue")).toHaveCount(0);
});

test("a transient transcription API failure returns to the waiting state and retries automatically", async ({ page }) => {
  const saved = await seedRecordingReview(page);
  await mockBlobClient(page);
  let reads = 0;
  let stage: "idle" | "processing" = "idle";
  await page.route("**/api/transcription-upload", route =>
    route.fulfill({ contentType: "application/json", body: "{}" }),
  );
  await page.route("**/api/transcriptions*", async route => {
    const request = route.request();
    if (request.method() === "POST") {
      stage = "processing";
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ...idle, status: "queued", jobId: "retry-job" }),
      });
    }
    reads++;
    if (reads === 1)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporarily unavailable" }),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...idle, status: stage, ...(stage === "processing" ? { jobId: "retry-job" } : {}) }),
    });
  });
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect(page.getByText("Temporarily unavailable", { exact: true })).toBeVisible();
  await expect.poll(() => reads, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(page.getByText(/Na fila para transcrição…|Transcrevendo sua gravação…/)).toBeVisible();
});

test('a cloud recording checks saved text before starting and persists its generated transcript once', async ({ page }) => {
  const saved = await seedRecordingReview(page);
  await mockBlobClient(page);
  const record = await page.evaluate(async saved => {
    const store = await import('/src/projects/store.ts');
    const take = store.listProjectTakes().find(item => item.id === saved.takeId)!;
    const record = { ...take, id: 'a0000000-0000-4000-8000-000000000002', localId: take.id, projectName: 'Projeto', status: 'ready' };
    store.mergeCloudRecordings([record]);
    return record;
  }, saved);
  let releaseStored: () => void = () => {};
  const holdStored = new Promise<void>(resolve => { releaseStored = resolve; });
  let stored: typeof automatic | null = null, version = 0, submitted = 0, uploaded = 0, statusReads = 0;
  const writes: any[] = [];
  await page.route('**/api/recordings*', async route => {
    expect(route.request().headers().authorization).toBe('Bearer fixture-session-token');
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      writes.push(body); expect(body.expectedVersion).toBe(version);
      stored = body.transcript; version++;
      return route.fulfill({ json: { version } });
    }
    if (new URL(route.request().url()).searchParams.get('transcript')) {
      await holdStored;
      return route.fulfill({ json: { transcript: stored, version } });
    }
    return route.fulfill({ json: { configured: true, recordings: [record], nextCursor: null, usedBytes: saved.bytes * 2, maxStorageBytes: 10 * 1024 ** 3 } });
  });
  await page.route('**/api/transcription-upload', route => { uploaded++; return route.fulfill({ json: {} }); });
  await page.route('**/api/transcriptions*', route => {
    if (route.request().method() === 'POST') submitted++;
    else statusReads++;
    return route.fulfill({ json: { ...idle, status: submitted ? 'completed' : 'idle', ...(submitted ? { jobId: 'cloud-generated', transcript: automatic } : {}) } });
  });
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect.poll(() => statusReads).toBeGreaterThan(0);
  expect(uploaded).toBe(0);
  releaseStored();
  await expect(page.getByRole('button', { name: 'Ir para palavra: criadores.' })).toBeVisible();
  await expect.poll(() => writes.length).toBe(1);
  expect(submitted).toBe(1);
  expect(writes[0]).toMatchObject({ action: 'transcript', recordingId: record.id, expectedVersion: 0, transcript: { origin: 'automatic', words: automatic.words } });
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Ir para palavra: criadores.' })).toBeVisible();
  expect(uploaded).toBe(1); expect(submitted).toBe(1); expect(writes).toHaveLength(1);
});

test('a saved cloud transcript remains visible and never triggers ASR when its local cache is full', async ({ page }) => {
  const saved = await seedRecordingReview(page);
  const record = await page.evaluate(async saved => {
    const store = await import('/src/projects/store.ts');
    const take = store.listProjectTakes().find(item => item.id === saved.takeId)!;
    const record = { ...take, id: 'a0000000-0000-4000-8000-000000000003', localId: take.id, projectName: 'Projeto', status: 'ready' };
    store.mergeCloudRecordings([record]); return record;
  }, saved);
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('grava-simples-transcript-v1')) throw new DOMException('Fixture quota full', 'QuotaExceededError');
      write.call(this, key, value);
    };
  });
  let uploads = 0, submissions = 0;
  await page.route('**/api/recordings*', route => route.fulfill({ json: new URL(route.request().url()).searchParams.has('transcript') ? { transcript: automatic, version: 3 } : { configured: true, recordings: [record], nextCursor: null, usedBytes: saved.bytes * 2, maxStorageBytes: 10 * 1024 ** 3 } }));
  await page.route('**/api/transcriptions*', route => { if (route.request().method() === 'POST') submissions++; return route.fulfill({ json: idle }); });
  await page.route('**/api/transcription-upload', route => { uploads++; return route.fulfill({ status: 503, json: { error: 'Unexpected upload' } }); });
  await openRecordingLibrary(page, saved.projectId);
  await openRecordingDetail(page);
  await expect(page.getByRole('button', { name: 'Ir para palavra: criadores.' })).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Ir para palavra: criadores.' })).toBeVisible();
  expect(uploads).toBe(0); expect(submissions).toBe(0);
});
