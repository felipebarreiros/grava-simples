import { expect, type Page } from "./auth";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const fixturePath = resolve(".context/recording-detail-fixture.mp4");
if (!existsSync(fixturePath)) {
  mkdirSync(resolve(".context"), { recursive: true });
  const result = spawnSync(
    process.env.FFMPEG ??
      resolve(".context/tools/node_modules/ffmpeg-static/ffmpeg"),
    [
      "-y",
      "-v",
      "error",
      "-loop",
      "1",
      "-i",
      resolve("public/scenes/mascot-concept.webp"),
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=48000",
      "-t",
      "8",
      "-vf",
      "scale=960:540",
      "-r",
      "15",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      fixturePath,
    ],
  );
  if (result.status !== 0) throw new Error(String(result.stderr));
}
const fixtureBytes = readFileSync(fixturePath);

export async function seedRecordingReview(page: Page) {
  await page.route("**/recording-detail-media.mp4", (route) =>
    route.fulfill({ contentType: "video/mp4", body: fixtureBytes }),
  );
  await page.route("**/recording-detail-fixture", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<html><body>Recording detail fixture</body></html>",
    }),
  );
  await page.goto("/recording-detail-fixture");
  return page.evaluate(async () => {
    localStorage.clear();
    const keys = await import("/src/projects/keys.ts");
    keys.setLocalAccount("user_fixture");
    const store = await import("/src/projects/store.ts");
    const { RecordingStore } = await import("/src/media/storage.ts");
    const project = store.loadProjects()[0];
    project.name = "Histórias que merecem ser contadas";
    project.settings.resolution = "360";
    store.saveProject(project);
    const blob = await (await fetch("/recording-detail-media.mp4")).blob();
    const recording = new RecordingStore("video/mp4");
    await recording.open();
    await recording.write("landscape", blob);
    await recording.write("portrait", blob);
    const files = await recording.finalize(true);
    const file = (orientation: "landscape" | "portrait") => ({
      orientation,
      blob: files[orientation],
      url: "",
      fileName: `historia-${orientation}.mp4`,
      mimeType: "video/mp4",
      size: files[orientation].size,
      durationMs: 8000,
    });
    const take = await store.saveProjectTake(project.id, {
      id: recording.id,
      landscape: file("landscape"),
      portrait: file("portrait"),
      startedAt: Date.now() - 8000,
      stoppedAt: Date.now(),
      warnings: [],
    });
    store.renameProjectTake(take.id, "Uma ideia merece sair do papel");
    return { projectId: project.id, takeId: take.id, bytes: blob.size };
  });
}

export async function openRecordingLibrary(page: Page, projectId: string) {
  await page.goto(`/app?test=1#project/${projectId}`, {
    waitUntil: "networkidle",
  });
  await expect
    .poll(() => page.evaluate(() => (window as any).__recorderTest?.ready))
    .toBe(true);
  await page.getByRole("tab", { name: /^Gravações/ }).click();
  await expect(page.locator(".recording-thumbnail img")).toBeVisible();
}

export async function openRecordingDetail(page: Page) {
  await page.locator(".take-cover").click();
  await expect(page.getByTestId("recording-detail")).toBeVisible();
  await expect
    .poll(() =>
      page
        .getByTestId("recording-video-landscape")
        .evaluate((video: HTMLVideoElement) => video.readyState),
    )
    .toBeGreaterThanOrEqual(2);
}
