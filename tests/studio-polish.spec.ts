import { test, expect, type Page } from "./fixtures/auth";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { selectValue } from "./helpers";

const evidence = resolve(".context/results/studio-polish");
const shots = resolve(".context/screenshots");
const state = (page: Page) =>
  page.evaluate(() => (window as any).__recorderTest);

async function waitEngine(page: Page) {
  await expect.poll(async () => (await state(page))?.ready).toBe(true);
}
async function prepare(page: Page) {
  await page.getByTestId("settings-trigger").click();
  await selectValue(page, "source-mode-select", "test");
  await selectValue(page, "resolution-select", "360");
  await selectValue(page, "fps-select", "30");
  await page.getByTestId("prepare-inputs").click();
  await expect
    .poll(async () => {
      const value = await state(page);
      expect(value.error).toBeFalsy();
      return value.status;
    })
    .toBe("ready");
  await expect(page.locator(".scene-inspector")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await page.keyboard.press("Escape");
}
async function pixels(page: Page, orientation = "landscape") {
  return page
    .getByTestId(`${orientation}-preview`)
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d")!,
        data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let purple = 0,
        orange = 0,
        face = 0,
        title = 0,
        timer = 0;
      for (let index = 0; index < data.length; index += 4) {
        const [r, g, b] = data.slice(index, index + 3),
          y = Math.floor(index / 4 / canvas.width) / canvas.height;
        if (r === 112 && g === 45 && b === 100) purple++;
        if (r > 245 && g >= 55 && g <= 80 && b < 15) orange++;
        if (
          Math.abs(r - 245) < 10 &&
          Math.abs(g - 154) < 10 &&
          Math.abs(b - 112) < 10
        )
          face++;
        if (r > 225 && g > 225 && b > 225 && y > 0.16 && y < 0.4) title++;
        if (r > 225 && g > 225 && b > 225 && y > 0.45 && y < 0.76) timer++;
      }
      const area = canvas.width * canvas.height;
      return {
        purple: purple / area,
        orange: orange / area,
        face: face / area,
        title: title / area,
        timer: timer / area,
        corner: [...context.getImageData(3, 3, 1, 1).data],
      };
    });
}
async function png(page: Page, color: string) {
  return Buffer.from(
    await page.evaluate(async (color) => {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((blob) => resolve(blob!), "image/png"),
      );
      return [...new Uint8Array(await blob.arrayBuffer())];
    }, color),
  );
}
async function instrumentPermissions(
  page: Page,
  camera: "prompt" | "granted" | "unsupported",
  microphone: "prompt" | "granted",
) {
  await page.addInitScript(
    ({ camera, microphone }) => {
      (window as any).__captureRequests = [];
      (window as any).__displayRequests = [];
      navigator.mediaDevices.getDisplayMedia = async (constraints) => {
        (window as any).__displayRequests.push(constraints);
        throw new DOMException(
          "Screen capture requires an explicit test gesture.",
          "NotAllowedError",
        );
      };
      const originalCapture = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        (window as any).__captureRequests.push(constraints);
        return originalCapture(constraints);
      };
      if (camera === "unsupported")
        Object.defineProperty(navigator, "permissions", {
          configurable: true,
          value: undefined,
        });
      else {
        const originalQuery = navigator.permissions.query.bind(
          navigator.permissions,
        );
        navigator.permissions.query = async (descriptor) => {
          const name = descriptor.name as string;
          if (name === "camera" || name === "microphone")
            return {
              state: name === "camera" ? camera : microphone,
            } as PermissionStatus;
          return originalQuery(descriptor);
        };
      }
    },
    { camera, microphone },
  );
}

for (const permission of ["prompt", "unsupported"] as const) {
  test(`opening a customer project never auto-prompts when camera permission is ${permission}`, async ({
    page,
  }) => {
    await instrumentPermissions(page, permission, "prompt");
    await page.goto("/app", { waitUntil: "networkidle" });
    await waitEngine(page);
    await page
      .getByRole("button", { name: "Abrir projeto Meu primeiro projeto" })
      .click();
    await expect(page.getByTestId("activate-camera")).toBeVisible();
    await page.waitForTimeout(400);
    expect(
      await page.evaluate(() => (window as any).__captureRequests),
    ).toEqual([]);
    expect((await state(page)).status).toBe("idle");
    if (permission === "prompt") {
      await page.getByTestId("scene-countdown").click();
      await expect.poll(async () => (await state(page)).status).toBe("ready");
      expect((await state(page)).config.microphone).toBe(false);
      expect(
        await page.evaluate(() => (window as any).__captureRequests),
      ).toEqual([]);
    }
  });
}
for (const mic of ["granted", "prompt"] as const) {
  test(`an existing camera grant restores preview automatically with microphone permission ${mic}`, async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["camera", "microphone"]);
    await instrumentPermissions(page, "granted", mic);
    await page.goto("/app", { waitUntil: "networkidle" });
    await waitEngine(page);
    await page
      .getByRole("button", { name: "Abrir projeto Meu primeiro projeto" })
      .click();
    await expect
      .poll(async () => {
        const value = await state(page);
        expect(value.error).toBeFalsy();
        return value.status;
      })
      .toBe("ready");
    const requests = await page.evaluate(
      () => (window as any).__captureRequests,
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request: MediaStreamConstraints) =>
        mic === "granted" ? !!request.audio : request.audio === false,
      ),
    ).toBe(true);
    expect((await state(page)).config.microphone).toBe(mic === "granted");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      resolve(evidence, `auto-camera-${mic}.json`),
      JSON.stringify({ requests, snapshot: await state(page) }, null, 2),
    );
  });
}

test("camera shape, outline, layer visibility and ordering affect only the selected scene and persist", async ({
  page,
}) => {
  await page.goto("/app?test=1", { waitUntil: "networkidle" });
  await waitEngine(page);
  await prepare(page);
  await page.getByTestId("scene-screen").click();
  await page.getByTestId("layer-select-camera").click();
  const rectangle = await pixels(page);
  await page.getByTestId("camera-shape-circle").click();
  await page.getByTestId("camera-outline").click();
  await page
    .getByRole("radio", { name: "Cor do contorno: laranja", exact: true })
    .click();
  await page.getByTestId("camera-shadow").click();
  await expect
    .poll(async () => (await pixels(page)).purple)
    .toBeLessThan(rectangle.purple * 0.8);
  for (const orientation of ["landscape", "portrait"])
    await expect
      .poll(async () => (await pixels(page, orientation)).orange)
      .toBeGreaterThan(0.0001);
  const styled = await pixels(page);
  await page.getByTestId("layer-eye-camera").click();
  for (const orientation of ["landscape", "portrait"])
    await expect
      .poll(async () => (await pixels(page, orientation)).face)
      .toBeLessThan(0.0001);
  await page.getByTestId("scene-camera").click();
  await expect
    .poll(async () => (await pixels(page)).face)
    .toBeGreaterThan(0.05);
  await page.getByTestId("scene-screen").click();
  await page.getByTestId("layer-select-camera").click();
  await expect(page.getByTestId("camera-shape-circle")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("layer-eye-camera")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByTestId("layer-eye-camera").click();
  await page
    .locator(".layer-name")
    .filter({ hasText: /^Câmera$/ })
    .click();
  await page.getByRole("button", { name: "Mover camada para baixo" }).click();
  await expect.poll(async () => (await pixels(page)).face).toBeLessThan(0.0001);
  await page.getByRole("button", { name: "Mover camada para cima" }).click();
  await expect
    .poll(async () => (await pixels(page)).face)
    .toBeGreaterThan(0.001);
  await page.reload({ waitUntil: "networkidle" });
  await waitEngine(page);
  await prepare(page);
  await page.getByTestId("layer-select-camera").click();
  await expect(page.getByTestId("camera-shape-circle")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("camera-outline")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("camera-shadow")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect
    .poll(async () => (await pixels(page)).orange)
    .toBeGreaterThan(0.0001);
  await mkdir(shots, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await page.mouse.click(950, 120);
  await page.screenshot({
    path: resolve(shots, "studio-camera-style.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(evidence, "scene-styling.json"),
    JSON.stringify({ rectangle, styled, restored: await state(page) }, null, 2),
  );
});

test("countdown title, custom background, timer and layers render in both outputs and restore after reload", async ({
  page,
}) => {
  await instrumentPermissions(page, "prompt", "prompt");
  await page.goto("/app?test=1", { waitUntil: "networkidle" });
  await waitEngine(page);
  await page.getByTestId("scene-countdown").click();
  await expect.poll(async () => (await state(page)).status).toBe("ready");
  await page.getByTestId("layer-select-title").click();
  await page.getByTestId("layer-text").fill("Lançamento do curso");
  await selectValue(page, "countdown-duration", "custom");
  await page.getByTestId("countdown-custom-minutes").fill("0.2");
  const file = await png(page, "#204080");
  await page.getByTestId("countdown-background-input").setInputFiles({
    name: "Fundo do curso.png",
    mimeType: "image/png",
    buffer: file,
  });
  for (const orientation of ["landscape", "portrait"]) {
    await expect
      .poll(async () => {
        const value = await pixels(page, orientation);
        return (
          value.corner[2] > value.corner[1] * 1.5 &&
          value.corner[1] > value.corner[0] * 1.5
        );
      })
      .toBe(true);
    await expect
      .poll(async () => (await pixels(page, orientation)).title)
      .toBeGreaterThan(0.001);
    await expect
      .poll(async () => (await pixels(page, orientation)).timer)
      .toBeGreaterThan(0.001);
  }
  expect((await state(page)).countdown.running).toBe(false);
  await page.getByTestId("countdown-toggle").click();
  const before = (await state(page)).countdown.remainingSeconds;
  await page.waitForTimeout(1250);
  expect((await state(page)).countdown.remainingSeconds).toBeLessThan(before);
  if ((await state(page)).countdown.running)
    await page.getByTestId("countdown-toggle").click();
  const paused = (await state(page)).countdown.remainingSeconds;
  await page.waitForTimeout(1100);
  expect((await state(page)).countdown.remainingSeconds).toBe(paused);
  await page.getByTestId("layer-eye-title").click();
  for (const orientation of ["landscape", "portrait"])
    await expect
      .poll(async () => (await pixels(page, orientation)).title)
      .toBeLessThan(0.0001);
  await page.getByTestId("layer-eye-title").click();
  await page.getByTestId("countdown-reset").click();
  await expect
    .poll(async () => (await state(page)).countdown.remainingSeconds)
    .toBe(12);
  expect((await state(page)).countdown.running).toBe(false);
  expect(await page.evaluate(() => (window as any).__captureRequests)).toEqual(
    [],
  );
  const initial = await state(page);
  await page.reload({ waitUntil: "networkidle" });
  await waitEngine(page);
  await prepare(page);
  await page.getByTestId("layer-select-title").click();
  await expect(page.getByTestId("layer-text")).toHaveValue(
    "Lançamento do curso",
  );
  await expect(page.getByTestId("countdown-duration")).toHaveAttribute("data-value", "custom");
  await expect(page.getByTestId("countdown-custom-minutes")).toHaveValue("0.2");
  for (const orientation of ["landscape", "portrait"])
    await expect
      .poll(async () => {
        const value = await pixels(page, orientation);
        return value.corner[2] > value.corner[1] * 1.5;
      })
      .toBe(true);
  await mkdir(shots, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await page.mouse.click(950, 120);
  await page.screenshot({
    path: resolve(shots, "studio-countdown.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(evidence, "countdown-ui.json"),
    JSON.stringify(
      {
        initial,
        restored: await state(page),
        captureRequests: await page.evaluate(
          () => (window as any).__captureRequests,
        ),
      },
      null,
      2,
    ),
  );
});

test("static scene diagrams stay still while real project covers, context menus and sidebar state persist", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    (window as any).__thumbnailDraws = {};
    CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
      const id = (this.canvas as HTMLCanvasElement).dataset?.testid;
      if (id?.startsWith("scene-preview-"))
        (window as any).__thumbnailDraws[id] =
          ((window as any).__thumbnailDraws[id] ?? 0) + 1;
      return (draw as any).apply(this, args);
    };
  });
  await page.goto("/app?test=1", { waitUntil: "networkidle" });
  await waitEngine(page);
  await prepare(page);
  const diagrams = page.locator(".schematic-preview");
  await expect(diagrams).toHaveCount(5);
  for (const scene of [
    "camera",
    "camera-zoom",
    "screen",
    "screen-3d",
    "countdown",
  ]) {
    const thumbnail = page.getByTestId(`scene-preview-${scene}`);
    await expect(thumbnail.locator("svg")).toHaveAttribute(
      "viewBox",
      "0 0 240 135",
    );
    await expect(thumbnail.locator("canvas")).toHaveCount(0);
    expect(
      await thumbnail.locator("svg").evaluate((svg) => svg.children.length),
    ).toBeGreaterThan(2);
  }
  const before = await diagrams.evaluateAll((elements) =>
    elements.map((element) => element.innerHTML),
  );
  await page.waitForTimeout(2800);
  const after = await diagrams.evaluateAll((elements) =>
    elements.map((element) => element.innerHTML),
  );
  expect(after).toEqual(before);
  expect(await page.evaluate(() => (window as any).__thumbnailDraws)).toEqual(
    {},
  );
  await expect
    .poll(async () =>
      (await state(page)).project.cover?.startsWith("data:image/jpeg;base64,"),
    )
    .toBe(true);
  const project = (await state(page)).project;
  await page
    .getByTestId(`project-nav-${project.id}`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Renomear projeto", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Renomear projeto" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Nome do projeto" })
    .fill("Meu estúdio");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await page
    .getByRole("button", { name: "Recolher menu", exact: true })
    .click();
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
  await page.locator(".app-shell").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.mouse.move(0, 0);
  await page.getByTestId(`project-nav-${project.id}`).hover();
  await expect(page.getByRole("tooltip")).toContainText("Meu estúdio");
  await expect
    .poll(async () => (await page.locator(".app-sidebar").boundingBox())!.width)
    .toBeLessThan(100);
  await page.reload({ waitUntil: "networkidle" });
  await waitEngine(page);
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);
  await page
    .getByRole("button", { name: "Expandir menu", exact: true })
    .click();
  await page
    .locator(".primary-nav")
    .getByRole("button", { name: "Todos os projetos" })
    .click();
  const cover = page.locator(".project-cover-image");
  await expect(cover).toHaveCount(1);
  await expect
    .poll(async () =>
      cover.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(100);
  await expect(page.getByTestId("project-card")).toContainText("Meu estúdio");
  await mkdir(shots, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: resolve(shots, "studio-project-covers.png"),
    fullPage: true,
  });
  await writeFile(
    resolve(evidence, "thumbnail-sidebar-cover.json"),
    JSON.stringify(
      { before, after, project: (await state(page)).project },
      null,
      2,
    ),
  );
});

test("switching between countdown scene IDs restores equal-duration timers paused", async ({
  page,
}) => {
  await page.goto("/app?test=1", { waitUntil: "networkidle" });
  await waitEngine(page);
  await page.getByTestId("scene-countdown").click();
  await expect.poll(async () => (await state(page)).status).toBe("ready");
  await selectValue(page, "countdown-duration", "custom");
  await page.getByTestId("countdown-custom-minutes").fill("0.2");
  await page
    .getByRole("button", { name: "Editar cena selecionada", exact: true })
    .click();
  await page.getByRole("button", { name: "Duplicar", exact: true }).click();
  const copy = (await state(page)).project.scenes.find(
    (scene: any) => scene.layout === "countdown" && scene.id !== "countdown",
  );
  expect(copy).toBeTruthy();
  await expect
    .poll(async () => (await state(page)).countdown.remainingSeconds)
    .toBe(12);
  expect((await state(page)).countdown.running).toBe(false);
  await page.getByTestId(`scene-${copy.id}`).click();
  await expect
    .poll(async () => (await state(page)).countdown.remainingSeconds)
    .toBeGreaterThanOrEqual(11);
  await expect
    .poll(async () => (await state(page)).countdown.remainingSeconds)
    .toBe(12);
  expect((await state(page)).countdown.running).toBe(false);
  await page.getByTestId("scene-countdown").click();
  await expect
    .poll(async () => (await state(page)).countdown.remainingSeconds)
    .toBeGreaterThanOrEqual(11);
});

for (const capture of ["camera", "screen"] as const) {
  test(`a saved countdown with a visible ${capture} layer never auto-prompts for an unknown grant`, async ({
    page,
  }) => {
    await instrumentPermissions(page, "prompt", "prompt");
    await page.goto("/app", { waitUntil: "networkidle" });
    await waitEngine(page);
    await page
      .getByRole("button", { name: "Abrir projeto Meu primeiro projeto" })
      .click();
    await page.getByTestId("scene-countdown").click();
    await expect.poll(async () => (await state(page)).status).toBe("ready");
    await page.getByTestId("add-source").click();
    await page
      .getByRole("menuitem", {
        name: capture === "camera" ? "Câmera" : "Tela ou mídia",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    if (capture === "screen") {
      // Represents a project whose display was connected in an earlier visit.
      await page.evaluate(() => {
        const key = "grava-simples-workspace-v1",
          workspace = JSON.parse(localStorage.getItem(key)!);
        const project = workspace.projects.find(
          (item: any) => item.id === workspace.activeProjectId,
        );
        project.settings.source = "screen";
        localStorage.setItem(key, JSON.stringify(workspace));
      });
    }
    await page.reload({ waitUntil: "networkidle" });
    await waitEngine(page);
    await page.waitForTimeout(500);
    const requests = await page.evaluate(() => ({
      camera: (window as any).__captureRequests,
      display: (window as any).__displayRequests,
    }));
    expect(requests).toEqual({ camera: [], display: [] });
    expect((await state(page)).status).toBe("idle");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      resolve(evidence, `custom-countdown-${capture}-permission.json`),
      JSON.stringify({ requests, snapshot: await state(page) }, null, 2),
    );
  });
}
