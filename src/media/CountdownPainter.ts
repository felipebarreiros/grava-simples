import type { SceneAppearance } from "./types";

export interface CountdownRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CountdownTextStyle {
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  label?: string;
}

const font = '"DM Sans", system-ui, sans-serif';
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** Static artwork and clock furniture are cached; only the editable glyphs change. */
export class CountdownPainter {
  private artworks = new Map<string, HTMLCanvasElement>();
  private plates = new Map<string, HTMLCanvasElement>();

  private canvas(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));
    return canvas;
  }

  private remember(
    cache: Map<string, HTMLCanvasElement>,
    key: string,
    canvas: HTMLCanvasElement,
  ) {
    if (cache.size >= 8) cache.delete(cache.keys().next().value!);
    cache.set(key, canvas);
    return canvas;
  }

  background(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    appearance: SceneAppearance,
  ): void {
    const base =
      appearance.backgroundColor === "#080b11"
        ? "#101010"
        : appearance.backgroundColor;
    const key = `${width}:${height}:${base}`;
    let artwork = this.artworks.get(key);
    if (!artwork) {
      artwork = this.canvas(width, height);
      const paint = artwork.getContext("2d", {
        alpha: false,
        willReadFrequently: true,
      })!;
      const short = Math.min(width, height);
      const portrait = height > width;
      paint.fillStyle = base;
      paint.fillRect(0, 0, width, height);

      // A warm aperture, rather than a flat wash, leaves a quiet central stage.
      const glow = paint.createRadialGradient(
        width * 0.96,
        height * 0.17,
        0,
        width * 0.96,
        height * 0.17,
        Math.max(width, height) * 0.82,
      );
      glow.addColorStop(0, "rgba(255,86,25,.31)");
      glow.addColorStop(0.29, "rgba(217,64,11,.12)");
      glow.addColorStop(0.66, "rgba(255,64,0,.025)");
      glow.addColorStop(1, "rgba(255,64,0,0)");
      paint.fillStyle = glow;
      paint.fillRect(0, 0, width, height);

      // Soft architectural fins give the background depth without busy motion.
      paint.save();
      paint.translate(width * (portrait ? 0.93 : 0.88), height * 0.12);
      paint.rotate(-0.4);
      const bandWidth = short * 0.19;
      const bandHeight = Math.max(width, height) * 1.55;
      for (let index = 0; index < 4; index++) {
        const x = index * short * 0.27;
        const sheen = paint.createLinearGradient(x, 0, x + bandWidth, 0);
        sheen.addColorStop(0, "rgba(255,179,132,0)");
        sheen.addColorStop(0.84, `rgba(255,148,84,${0.018 + index * 0.005})`);
        sheen.addColorStop(1, "rgba(255,219,191,.075)");
        paint.fillStyle = sheen;
        paint.fillRect(x, -bandHeight / 2, bandWidth, bandHeight);
        paint.strokeStyle = "rgba(255,172,122,.055)";
        paint.lineWidth = Math.max(0.6, short / 1600);
        paint.beginPath();
        paint.moveTo(x + bandWidth, -bandHeight / 2);
        paint.lineTo(x + bandWidth, bandHeight / 2);
        paint.stroke();
      }
      paint.restore();

      const grounding = paint.createLinearGradient(0, height * 0.4, 0, height);
      grounding.addColorStop(0, "rgba(0,0,0,0)");
      grounding.addColorStop(1, "rgba(0,0,0,.31)");
      paint.fillStyle = grounding;
      paint.fillRect(0, 0, width, height);

      // Deterministic, low-contrast grain is generated once, never per frame.
      let seed = 8271;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      const grain = Math.min(6000, Math.ceil((width * height) / 580));
      for (let index = 0; index < grain; index++) {
        paint.fillStyle =
          index % 2 ? "rgba(255,236,218,.023)" : "rgba(0,0,0,.045)";
        const dot = Math.max(0.65, short / 1550);
        paint.fillRect(random() * width, random() * height, dot, dot);
      }
      this.remember(this.artworks, key, artwork);
    }
    context.drawImage(artwork, 0, 0, width, height);
  }

  drawTitle(
    context: CanvasRenderingContext2D,
    rect: CountdownRect,
    text: string,
    style: CountdownTextStyle = {},
  ): void {
    if (!rect.width || !rect.height || !text.trim()) return;
    context.save();
    context.fillStyle = style.color ?? "#f8f5f0";
    context.textAlign = style.align ?? "center";
    context.textBaseline = "middle";
    context.fontKerning = "normal";
    let size = clamp(
      style.fontSize ?? Math.min(rect.width * 0.067, rect.height * 0.58),
      8,
      rect.height * 0.82,
    );
    let lines: string[] = [];
    const wrap = () => {
      context.font = `550 ${size}px ${font}`;
      const words = text.trim().split(/\s+/);
      const rows: string[] = [];
      let row = "";
      for (const word of words) {
        const candidate = row ? `${row} ${word}` : word;
        if (row && context.measureText(candidate).width > rect.width * 0.98) {
          rows.push(row);
          row = word;
        } else row = candidate;
      }
      if (row) rows.push(row);
      if (rows.length === 2 && words.length > 2) {
        // Keep short portrait headings balanced instead of leaving a lone word.
        let balance = Number.POSITIVE_INFINITY;
        for (let split = 1; split < words.length; split++) {
          const first = words.slice(0, split).join(" "),
            second = words.slice(split).join(" ");
          const firstWidth = context.measureText(first).width,
            secondWidth = context.measureText(second).width;
          const difference = Math.abs(firstWidth - secondWidth);
          if (
            firstWidth <= rect.width &&
            secondWidth <= rect.width &&
            difference < balance
          ) {
            balance = difference;
            rows[0] = first;
            rows[1] = second;
          }
        }
      }
      return rows;
    };
    lines = wrap();
    while (
      (lines.length * size * 1.16 > rect.height ||
        lines.some((line) => context.measureText(line).width > rect.width)) &&
      size > 10
    ) {
      size *= 0.94;
      lines = wrap();
    }
    const x =
      context.textAlign === "left"
        ? rect.x
        : context.textAlign === "right"
          ? rect.x + rect.width
          : rect.x + rect.width / 2;
    const middle = rect.y + rect.height / 2;
    lines.forEach((line, index) =>
      context.fillText(
        line,
        x,
        middle + (index - (lines.length - 1) / 2) * size * 1.16,
        rect.width,
      ),
    );
    context.restore();
  }

  drawTimer(
    context: CanvasRenderingContext2D,
    rect: CountdownRect,
    remainingSeconds: number,
    style: CountdownTextStyle = {},
  ): void {
    if (rect.width <= 0 || rect.height <= 0) return;
    const total = Math.max(0, Math.ceil(remainingSeconds));
    const minutes = Math.floor(total / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (total % 60).toString().padStart(2, "0");
    const glyphCount = minutes.length + seconds.length;
    const size = clamp(
      style.fontSize ?? rect.height * 0.65,
      8,
      Math.min(rect.height / 1.57, rect.width / (glyphCount * 0.61 + 1.1)),
    );
    const digitWidth = size * 0.61;
    const gap = size * 0.35;
    const textWidth = glyphCount * digitWidth + gap;
    const plateWidth = Math.min(rect.width, textWidth + size * 0.81);
    const plateHeight = Math.min(rect.height, size * 1.57);
    const align = style.align ?? "center";
    const x =
      align === "left"
        ? rect.x
        : align === "right"
          ? rect.x + rect.width - plateWidth
          : rect.x + (rect.width - plateWidth) / 2;
    const y = rect.y + (rect.height - plateHeight) / 2;
    const plateKey = `${Math.round(plateWidth)}:${Math.round(plateHeight)}`;
    let plate = this.plates.get(plateKey);
    if (!plate) {
      plate = this.canvas(plateWidth + 4, plateHeight + 4);
      const paint = plate.getContext("2d", { willReadFrequently: true })!;
      paint.beginPath();
      paint.roundRect(2, 2, plateWidth, plateHeight, size * 0.13);
      const glass = paint.createLinearGradient(0, 0, plateWidth, plateHeight);
      glass.addColorStop(0, "rgba(255,255,255,.035)");
      glass.addColorStop(0.48, "rgba(255,255,255,.018)");
      glass.addColorStop(1, "rgba(255,112,62,.045)");
      paint.fillStyle = glass;
      paint.fill();
      const edge = paint.createLinearGradient(0, 0, plateWidth, plateHeight);
      edge.addColorStop(0, "rgba(255,255,255,.12)");
      edge.addColorStop(0.55, "rgba(255,255,255,.055)");
      edge.addColorStop(1, "rgba(255,146,100,.22)");
      paint.strokeStyle = edge;
      paint.lineWidth = Math.max(0.65, size * 0.0045);
      paint.stroke();
      this.remember(this.plates, plateKey, plate);
    }

    context.save();
    context.drawImage(plate, x - 2, y - 2, plateWidth + 4, plateHeight + 4);
    const contentX = x + (plateWidth - textWidth) / 2;
    const baseline = y + plateHeight * 0.725;
    const labelY = y + plateHeight * 0.175;
    const label =
      style.label ?? (total > 0 ? "COMEÇAMOS EM" : "A SUA HORA CHEGOU");
    const labelSize = Math.max(6, size * 0.1);
    context.fillStyle = "#ed986f";
    context.font = `600 ${labelSize}px ${font}`;
    context.textBaseline = "middle";
    context.textAlign = "center";
    context.fillText(label, x + plateWidth / 2, labelY, plateWidth * 0.82);

    context.font = `450 ${size}px ${font}`;
    context.textBaseline = "alphabetic";
    context.fillStyle = style.color ?? "#fffaf4";
    let cursor = contentX;
    const digits = (value: string) => {
      for (const character of value) {
        context.fillText(character, cursor + digitWidth / 2, baseline);
        cursor += digitWidth;
      }
    };
    digits(minutes);
    const colonX = cursor + gap / 2;
    context.fillStyle = "#fb7644";
    for (const offset of [0.5, 0.23]) {
      context.beginPath();
      context.arc(
        colonX,
        baseline - size * offset,
        Math.max(1, size * 0.026),
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    cursor += gap;
    context.fillStyle = style.color ?? "#fffaf4";
    digits(seconds);

    context.fillStyle = "#8f8680";
    context.font = `550 ${Math.max(5, size * 0.069)}px ${font}`;
    context.textBaseline = "middle";
    const unitY = y + plateHeight * 0.86;
    context.fillText(
      "MINUTOS",
      contentX + (minutes.length * digitWidth) / 2,
      unitY,
    );
    context.fillText(
      "SEGUNDOS",
      contentX +
        minutes.length * digitWidth +
        gap +
        (seconds.length * digitWidth) / 2,
      unitY,
    );
    context.restore();
  }

  clear(): void {
    this.artworks.clear();
    this.plates.clear();
  }
}
