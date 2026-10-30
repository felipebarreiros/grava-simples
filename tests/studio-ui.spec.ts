import { test, expect, type Page } from "./fixtures/auth";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { selectValue } from "./helpers";

const screenshots = resolve(".context/screenshots");
const results = resolve(".context/results/hotmart-ui");
const orientations = ["landscape", "portrait"] as const;

type StudioSnapshot = {
  ready?: boolean;
  status?: string;
  state?: string;
  error?: string;
  config?: { layout?: string; source?: string };
  controls?: {
    cameraZoom?: number;
    sourceVisibility?: { camera: boolean; screen: boolean };
    microphoneMuted?: boolean;
    microphoneGainDb?: number;
  };
  metrics?: {
    audioLevel?: number;
    audioLevelDb?: number;
    sources?: { screen?: { live?: boolean } };
  };
  project?: {
    id: string;
    name: string;
    selectedSceneId: string;
    scenes: { id: string; zoom?: number }[];
  };
  projects?: { id: string; name: string }[];
  takes?: { id: string; projectId: string }[];
};

async function snapshot(page: Page): Promise<StudioSnapshot> {
  return page.evaluate(() => {
    const hook = (window as any).__recorderTest;
    return typeof hook === "function"
      ? hook()
      : typeof hook?.snapshot === "function"
        ? hook.snapshot()
        : hook;
  });
}

async function openStudio(page: Page) {
  await page.goto("/app?test=1", { waitUntil: "networkidle" });
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true);
}

async function prepareDemo(page: Page) {
  await page.getByTestId("settings-trigger").click();
  await selectValue(page, "source-mode-select", "test");
  await selectValue(page, "resolution-select", "360");
  await selectValue(page, "fps-select", "30");
  await page.getByTestId("prepare-inputs").click();
  await expect
    .poll(async () => {
      const value = await snapshot(page);
      expect(value.error).toBeFalsy();
      return value.status ?? value.state;
    })
    .toBe("ready");
  await expect(page.locator(".scene-inspector")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await page.keyboard.press("Escape");
}

async function palette(page: Page) {
  return Promise.all(
    orientations.map(async (orientation) => {
      const pixels = await page
        .getByTestId(`${orientation}-preview`)
        .evaluate((canvas: HTMLCanvasElement) => {
          const data = canvas
            .getContext("2d")!
            .getImageData(0, 0, canvas.width, canvas.height).data;
          let face = 0,
            screen = 0,
            background = 0,
            orange = 0,
            faceRight = 0,
            faceBottom = 0,
            screenLeft = 0,
            screenTop = 0,
            screenBottom = 0;
          for (let index = 0; index < data.length; index += 4) {
            const red = data[index],
              green = data[index + 1],
              blue = data[index + 2];
            if (
              Math.abs(red - 245) < 10 &&
              Math.abs(green - 154) < 10 &&
              Math.abs(blue - 112) < 10
            ) {
              face++;
              const pixel = index / 4;
              if (pixel % canvas.width >= canvas.width * .55) faceRight++;
              if (pixel / canvas.width >= canvas.height * .5) faceBottom++;
            }
            if (
              red >= 16 &&
              red <= 28 &&
              green >= 25 &&
              green <= 60 &&
              blue >= 55 &&
              blue <= 102
            ) {
              screen++;
              const pixel = index / 4;
              if (pixel % canvas.width < canvas.width * .63) screenLeft++;
              if (pixel / canvas.width < canvas.height * .45) screenTop++;
              if (pixel / canvas.width >= canvas.height * .6) screenBottom++;
            }
            if (red === 8 && green === 11 && blue === 17) background++;
            if (red === 255 && green === 64 && blue === 0) orange++;
          }
          const count = canvas.width * canvas.height;
          return {
            face: face / count,
            screen: screen / count,
            background: background / count,
            orange: orange / count,
            faceRight: faceRight / count,
            faceBottom: faceBottom / count,
            screenLeft: screenLeft / count,
            screenTop: screenTop / count,
            screenBottom: screenBottom / count,
            width: canvas.width,
            height: canvas.height,
          };
        });
      return { orientation, ...pixels };
    }),
  );
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 2560, height: 1440 },
  { width: 768, height: 900 },
]) {
  test(`studio controls and previews fit ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await openStudio(page);
    await prepareDemo(page);
    for (const id of [
      "scene-camera",
      "scene-camera-zoom",
      "scene-screen",
      "scene-screen-3d",
      "scene-countdown",
      "start-recording",
      "add-source",
      "layer-eye-camera",
      "microphone-mute",
      "landscape-preview",
      "portrait-preview",
    ]) {
      const control = page.getByTestId(id);
      await expect(control).toBeVisible();
      if (
        id === "microphone-mute" ||
        id === "layer-eye-camera" ||
        id === "add-source"
      )
        await control.scrollIntoViewIfNeeded();
      if (viewport.width < 1280 && id.startsWith("scene-"))
        await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box, `${id} has a rendered box`).not.toBeNull();
      expect(box!.x, `${id} left boundary`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${id} right boundary`).toBeLessThanOrEqual(
        viewport.width + 1,
      );
      if (viewport.width >= 1280) {
        await expect(control).toBeInViewport({ ratio: 0.99 });
        expect(box!.y, `${id} top boundary`).toBeGreaterThanOrEqual(0);
        expect(
          box!.y + box!.height,
          `${id} bottom boundary`,
        ).toBeLessThanOrEqual(viewport.height + 1);
      }
    }
    for (const scene of [
      "camera",
      "camera-zoom",
      "screen",
      "screen-3d",
      "countdown",
    ]) {
      const bounds = await page
        .getByTestId(`scene-${scene}`)
        .evaluate((button) => {
          const outer = button.getBoundingClientRect(),
            inner = button
              .querySelector(".scene-thumbnail, .scene-preview")!
              .getBoundingClientRect();
          return {
            outer: {
              left: outer.left,
              right: outer.right,
              top: outer.top,
              bottom: outer.bottom,
            },
            inner: {
              left: inner.left,
              right: inner.right,
              top: inner.top,
              bottom: inner.bottom,
            },
          };
        });
      expect(
        bounds.inner.left,
        `${scene} thumbnail stays inside its card`,
      ).toBeGreaterThanOrEqual(bounds.outer.left - 1);
      expect(
        bounds.inner.right,
        `${scene} thumbnail stays inside its card`,
      ).toBeLessThanOrEqual(bounds.outer.right + 1);
      expect(
        bounds.inner.top,
        `${scene} thumbnail stays inside its card`,
      ).toBeGreaterThanOrEqual(bounds.outer.top - 1);
      expect(
        bounds.inner.bottom,
        `${scene} thumbnail stays inside its card`,
      ).toBeLessThanOrEqual(bounds.outer.bottom + 1);
    }
    await expect(page.getByTestId("resolution-select")).not.toBeVisible();
    await expect(page.getByTestId("fps-select")).not.toBeVisible();
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
    expect(dimensions.height).toBeLessThanOrEqual(
      dimensions.viewportHeight + 1,
    );
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({
      path: resolve(
        screenshots,
        `hotmart-studio-${viewport.width}x${viewport.height}.png`,
      ),
      fullPage: true,
    });
  });
}

test("customer pages hide diagnostic sources and technical settings behind preferences", async ({
  page,
}) => {
  await page.goto("/app", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Suas ideias, em cena." }),
  ).toBeVisible();
  await expect(page.getByTestId("project-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Abrir projeto Meu primeiro projeto" })
    .click();
  await expect(page.getByTestId("activate-camera")).toBeVisible();
  await expect(page.getByTestId("source-mode-select")).toHaveCount(0);
  await expect(page.getByTestId("prepare-inputs")).toHaveCount(0);
  await expect(page.locator("footer")).toHaveCount(0);
  await expect(
    page.getByText(
      /FPS rendering|Experiment|Pronto para gravar|Demonstração|Full HD/,
    ),
  ).not.toBeVisible();
  await page.getByTestId("settings-trigger").click();
  await expect(page.getByTestId("resolution-select")).toBeVisible();
  await expect(page.getByTestId("fps-select")).toBeVisible();
  await expect(page.getByTestId("source-mode-select")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: resolve(screenshots, "hotmart-studio-empty.png"),
    fullPage: true,
  });
});

test("adjustable zoom, perspective scene, source visibility and microphone controls affect actual outputs", async ({
  page,
}) => {
  await openStudio(page);
  await prepareDemo(page);
  await page.getByTestId("scene-camera").click();
  const camera = await palette(page);
  await page.getByTestId("scene-camera-zoom").click();
  const zoom = page.getByTestId("camera-zoom");
  await zoom.focus();
  await zoom.press("Home");
  await zoom.press("ArrowRight");
  await zoom.press("ArrowRight");
  const zoom12 = await palette(page);
  await expect
    .poll(async () => (await snapshot(page)).controls?.cameraZoom)
    .toBeCloseTo(1.2);
  for (let i = 0; i < 8; i++) await zoom.press("ArrowRight");
  const zoom20 = await palette(page);
  await expect
    .poll(async () => (await snapshot(page)).controls?.cameraZoom)
    .toBeCloseTo(2);
  for (const index of [0, 1])
    expect(
      zoom20[index].face,
      `${zoom20[index].orientation} higher zoom changes actual crop`,
    ).toBeGreaterThan(zoom12[index].face * 1.2);
  await page.getByTestId("layer-eye-camera").click();
  await expect
    .poll(async () =>
      (await palette(page)).every((value) => value.background > 0.99),
    )
    .toBe(true);
  await page.getByTestId("layer-eye-camera").click();
  await page.getByTestId("scene-screen").click();
  const screen = await palette(page);
  for (const value of screen)
    expect(
      value.screen,
      `${value.orientation} has screen pixels`,
    ).toBeGreaterThan(0.1);
  await page.getByTestId("scene-screen-3d").click();
  const perspective = await palette(page);
  for (const index of [0, 1]) {
    expect(
      perspective[index].face,
      `${perspective[index].orientation} presenter stays prominent`,
    ).toBeGreaterThan(0.015);
    expect(
      perspective[index].screen,
      `${perspective[index].orientation} presentation slide is actually drawn`,
    ).toBeGreaterThan(0.03);
  }
  expect(perspective[0].screenLeft, "Landscape slide occupies the left panel").toBeGreaterThan(.1);
  expect(perspective[0].faceRight, "Landscape presenter remains visible on the right").toBeGreaterThan(.03);
  expect(perspective[1].screenTop, "Portrait slide occupies the top panel").toBeGreaterThan(.1);
  expect(perspective[1].screenBottom, "Portrait slide does not cover the lower camera panel").toBeLessThan(.01);
  expect(perspective[1].faceBottom, "Portrait presenter remains visible below the slide").toBeGreaterThan(.03);
  await page.getByTestId("layer-eye-screen").click();
  await expect
    .poll(async () =>
      (await palette(page)).every((value) => value.screen < 0.01),
    )
    .toBe(true);
  await page.getByTestId("layer-eye-screen").click();
  await expect
    .poll(async () => (await snapshot(page)).metrics?.audioLevel ?? 0)
    .toBeGreaterThan(0.001);
  const unmuted = await snapshot(page);
  await page.getByTestId("microphone-mute").click();
  await expect
    .poll(async () => (await snapshot(page)).metrics?.audioLevelDb ?? 0)
    .toBeLessThan(-80);
  await page.getByTestId("microphone-mute").click();
  await expect
    .poll(async () => (await snapshot(page)).metrics?.audioLevel ?? 0)
    .toBeGreaterThan(0.001);
  const gain = page.getByTestId("microphone-gain");
  await gain.focus();
  await gain.press("Home");
  await expect
    .poll(async () => (await snapshot(page)).metrics?.audioLevelDb ?? 0)
    .toBeLessThan((unmuted.metrics?.audioLevelDb ?? -15) - 12);
  await gain.press("End");
  await expect
    .poll(async () => (await snapshot(page)).metrics?.audioLevel ?? 0)
    .toBeGreaterThan((unmuted.metrics?.audioLevel ?? 0.001) * 1.8);
  await mkdir(results, { recursive: true });
  await writeFile(
    resolve(results, "live-controls.json"),
    JSON.stringify(
      {
        camera,
        zoom12,
        zoom20,
        screen,
        perspective,
        unmuted,
        restored: await snapshot(page),
      },
      null,
      2,
    ),
  );
});

test("project creation, scene zoom, rename, search and reload remain isolated per project", async ({
  page,
}) => {
  await page.goto("/app", { waitUntil: "networkidle" });
  await expect.poll(async () => (await snapshot(page))?.ready).toBe(true);
  const first = (await snapshot(page)).project!;
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "Novo projeto", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Nome do projeto" })
    .fill("Curso de fotografia");
  await page.getByRole("button", { name: "Criar projeto" }).click();
  await expect(page.locator(".project-title-button")).toContainText(
    "Curso de fotografia",
  );
  await page.getByTestId("scene-camera-zoom").click();
  await page.getByTestId("camera-zoom").focus();
  await page.getByTestId("camera-zoom").press("End");
  const second = (await snapshot(page)).project!;
  expect(second.id).not.toBe(first.id);
  await page.locator(".project-title-button").click();
  await page.getByRole("menuitem", { name: "Renomear projeto", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Nome do projeto" })
    .fill("Curso de vídeo");
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await page.getByTestId(`project-nav-${first.id}`).click();
  await page.getByTestId("scene-camera-zoom").click();
  await expect(page.getByTestId("camera-zoom")).toHaveAttribute(
    "aria-valuenow",
    "1.6",
  );
  await page.getByTestId(`project-nav-${second.id}`).click();
  await expect(page.getByTestId("camera-zoom")).toHaveAttribute(
    "aria-valuenow",
    "2.5",
  );
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.locator(".project-title-button")).toContainText(
    "Curso de vídeo",
  );
  await expect(page.getByTestId("camera-zoom")).toHaveAttribute(
    "aria-valuenow",
    "2.5",
  );
  await page
    .locator(".primary-nav")
    .getByRole("button", { name: "Todos os projetos" })
    .click();
  await page.locator(".primary-nav").getByRole("button", { name: "Buscar", exact: true }).click();
  const searchDialog = page.getByRole("dialog", { name: "Busca global" });
  await searchDialog.getByRole("combobox").fill("vídeo");
  await searchDialog.getByRole("tab", { name: /^Projetos/ }).click();
  await expect(searchDialog.getByRole("option")).toHaveCount(1);
  await expect(searchDialog.getByRole("option")).toContainText(
    "Curso de vídeo",
  );
  await searchDialog.getByRole("combobox").fill("não existe");
  await expect(searchDialog.getByRole("option")).toHaveCount(0);
  await expect(searchDialog.getByText("Nenhum resultado por aqui")).toBeVisible();
  await page.keyboard.press("Escape");
  await mkdir(results, { recursive: true });
  await writeFile(
    resolve(results, "projects.json"),
    JSON.stringify(await snapshot(page), null, 2),
  );
});

test("source plus opens an explicit chooser and imports a real image into both canvases", async ({
  page,
}) => {
  await page.context().grantPermissions(["camera", "microphone"]);
  await openStudio(page);
  await prepareDemo(page);
  await page.getByTestId("add-source").click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByRole("menuitem", { name: /Tela ou mídia/ }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: /Importar imagem ou vídeo/ }),
  ).toBeVisible();
  await menu
    .getByRole("menuitem", { name: /Importar imagem ou vídeo/ })
    .click();
  const png = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#ff4000";
    context.fillRect(0, 0, 320, 180);
    return [
      ...new Uint8Array(
        await (
          await new Promise<Blob>((resolve) =>
            canvas.toBlob((blob) => resolve(blob!), "image/png"),
          )
        ).arrayBuffer(),
      ),
    ];
  });
  await page.getByTestId("media-file-input").setInputFiles({
    name: "Minha apresentação.png",
    mimeType: "image/png",
    buffer: Buffer.from(png),
  });
  await expect(menu).not.toBeVisible();
  await expect
    .poll(async () =>
      (await palette(page)).every((value) => value.orange > 0.05),
    )
    .toBe(true);
  const imageOutputs = await palette(page);
  const importedLayer = await page.evaluate(() => {
    const h = (window as any).__recorderTest;
    return h.project.scenes
      .find((scene: any) => scene.id === h.project.selectedSceneId)
      .appearance.layers.find((layer: any) => layer.assetId);
  });
  expect(importedLayer.sourceId).toBeTruthy();
  expect(importedLayer.assetId).toBeTruthy();
  await page.getByTestId(`layer-eye-${importedLayer.id}`).click();
  await expect
    .poll(async () =>
      (await palette(page)).every((value) => value.orange < 0.001),
    )
    .toBe(true);
  await page.getByTestId(`layer-eye-${importedLayer.id}`).click();
  await expect
    .poll(async () =>
      (await palette(page)).every((value) => value.orange > 0.05),
    )
    .toBe(true);
  await mkdir(results, { recursive: true });
  await writeFile(
    resolve(results, "media-import.json"),
    JSON.stringify({ imageOutputs, snapshot: await snapshot(page) }, null, 2),
  );
});

test("scene keyboard shortcuts and settings dialog support keyboard focus and Escape", async ({
  page,
}) => {
  await openStudio(page);
  await prepareDemo(page);
  for (const [key, scene] of [
    ["1", "camera"],
    ["2", "camera-zoom"],
    ["3", "screen"],
    ["4", "screen-3d"],
    ["5", "countdown"],
  ]) {
    await page.keyboard.press(key);
    await expect(page.getByTestId(`scene-${scene}`)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  const settings = page.getByTestId("settings-trigger");
  await settings.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(async () =>
      dialog.evaluate((element) => element.contains(document.activeElement)),
    )
    .toBe(true);
  const resolution = page.getByTestId("resolution-select");
  expect(await resolution.evaluate((element) => element.tagName)).toBe(
    "BUTTON",
  );
  await resolution.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.locator(".gs-select-content")).toHaveCSS(
    "background-color",
    "rgb(37, 37, 37)",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(resolution).toBeFocused();
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: resolve(screenshots, "hotmart-settings.png"),
    fullPage: true,
  });
  for (let count = 0; count < 20; count++) {
    await page.keyboard.press("Tab");
    await expect
      .poll(async () =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
});
