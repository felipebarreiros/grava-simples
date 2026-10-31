import { memo, useId } from "react";
import {
  defaultSceneAppearance,
  containedRect,
  getLayerFontSize,
  getLayerFrame,
  getLayerTextAlign,
  getPresentationQuad,
  getPresentationSlices,
} from "../media/SceneCompositor";
import type { ProjectScene } from "../projects/store";
import { CountdownArtwork, ScreenArtwork } from "./SceneArtwork";

const mascot = "/scenes/mascot-concept.webp";
const presentationSlide = "/scenes/presentation-slide.webp";
const countdownStudio = "/scenes/countdown-studio.webp";

/** Static example artwork follows scene edits without sampling or requesting media. */
export const ScenePreview = memo(function ScenePreview({
  scene,
}: {
  scene: ProjectScene;
}) {
  const uid = useId().replace(/:/g, "");
  const appearance = scene.appearance ?? defaultSceneAppearance(scene.layout);
  const seconds = Math.max(0, Math.ceil(appearance.countdownSeconds));
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  const zoom = scene.layout === "camera-zoom"
    ? Math.max(1, Math.min(2.5, scene.zoom ?? 1.4)) : 1;
  const layers = appearance.layers.filter((layer) => layer.visible);

  return (
    <div
      className="scene-preview schematic-preview"
      data-testid={`scene-preview-${scene.id}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 240 135" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id={`${uid}-glass`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity=".055" />
            <stop offset="1" stopColor="#ff7545" stopOpacity=".045" />
          </linearGradient>
        </defs>
        <rect width="240" height="135" fill="#171717" />
        {layers.map((layer, index) => {
          const frame = getLayerFrame(layer, {
            layout: scene.layout,
            appearance,
            orientation: "landscape",
            width: 240,
            height: 135,
          });
          const x = frame.x * 240, y = frame.y * 135;
          const w = frame.width * 240, h = frame.height * 135;
          const id = `${uid}-layer-${index}`;

          if (layer.kind === "background") {
            const defaultBackground = appearance.backgroundColor.toLowerCase() === "#080b11";
            return (
              <g key={layer.id} data-preview-layer={layer.id}
                transform={`translate(${x} ${y}) scale(${w / 240} ${h / 135})`}>
                <defs>
                  <clipPath id={id}>
                    <rect width="240" height="135" />
                  </clipPath>
                </defs>
                <g clipPath={`url(#${id})`}>
                  {scene.layout === "countdown" ? (
                    <>
                      <CountdownArtwork id={id} color={appearance.backgroundColor} />
                      <image href={countdownStudio} width="240" height="135"
                        preserveAspectRatio="xMidYMid slice" opacity={defaultBackground ? 1 : .35} />
                    </>
                  ) : (
                    <rect width="240" height="135" fill={appearance.backgroundColor} />
                  )}
                  {appearance.backgroundAssetId && (
                    <g opacity=".15" fill="none" stroke="#f5f3ef" strokeWidth=".7">
                      <rect x="16" y="16" width="208" height="103" rx="6" />
                      <path d="M16 104 70 64 110 89 167 43 224 93" />
                      <circle cx="65" cy="42" r="8" />
                    </g>
                  )}
                </g>
              </g>
            );
          }

          if (layer.kind === "camera") {
            const shape = layer.cameraShape ?? appearance.cameraShape;
            const radius = shape === "circle" ? Math.min(w, h) / 2
              : shape === "rounded" ? Math.min(w, h) * .13 : 0;
            const border = (layer.cameraBorderWidth ?? appearance.cameraBorderWidth) / 8;
            const shadow = layer.cameraShadow ?? appearance.cameraShadow;
            const defaultPresentationCamera = scene.layout === "screen-3d"
              && !layer.frames?.landscape
              && appearance.layers.find(item => item.kind === "camera")?.id === layer.id;
            const inset = !defaultPresentationCamera && (frame.width < .9 || frame.height < .9);
            const scaledWidth = w * zoom, scaledHeight = h * zoom;
            return (
              <g key={layer.id} data-preview-layer={layer.id}>
                <defs>
                  <clipPath id={id}>
                    <rect x={x} y={y} width={w} height={h} rx={radius} />
                  </clipPath>
                </defs>
                {(inset || shadow) && (
                  <rect x={x - 1} y={y + 1} width={w + 2} height={h + 2}
                    rx={radius + 1} fill="#000000" opacity=".35" />
                )}
                <g clipPath={`url(#${id})`}>
                  <rect x={x} y={y} width={w} height={h} fill="#242424" />
                  <image href={mascot}
                    x={x - (scaledWidth - w) / 2}
                    y={y - (scaledHeight - h) / 2}
                    width={scaledWidth} height={scaledHeight}
                    preserveAspectRatio={layer.fit === "contain" && shape !== "circle" ? "xMidYMid meet" : "xMidYMid slice"}
                    data-preview-zoom={zoom} />
                </g>
                {(inset || border > 0) && (
                  <rect x={x} y={y} width={w} height={h} rx={radius}
                    fill="none" stroke={border > 0 ? layer.cameraBorderColor ?? appearance.cameraBorderColor : "#f5f3ef"}
                    strokeWidth={border || .6} strokeOpacity={border > 0 ? 1 : .55} />
                )}
              </g>
            );
          }

          if (layer.kind === "screen") {
            if (scene.layout === "screen-3d") {
              const rect = layer.fit === "cover" ? { x, y, width: w, height: h }
                : containedRect(240, 180, x, y, w, h);
              const quad = getPresentationQuad(rect).map(([px, py]) => `${px},${py}`).join(" ");
              const cropWidth = Math.min(240, 180 * w / h);
              const cropHeight = Math.min(180, 240 * h / w);
              const cropX = layer.fit === "cover" ? (240 - cropWidth) / 2 : 0;
              const cropY = layer.fit === "cover" ? (180 - cropHeight) / 2 : 0;
              const sourceWidth = layer.fit === "cover" ? cropWidth : 240;
              const sourceHeight = layer.fit === "cover" ? cropHeight : 180;
              return (
                <g key={layer.id} data-preview-layer={layer.id}>
                  <defs>
                    <clipPath id={id}><polygon points={quad} /></clipPath>
                  </defs>
                  <polygon points={quad} transform="translate(.5 1.5)" fill="#000000" opacity=".4" />
                  <polygon points={quad} transform="translate(.35 .6)" fill="#49403b" />
                  <g clipPath={`url(#${id})`}>
                    {getPresentationSlices(rect, 2).map((slice, sliceIndex) => (
                      <svg key={sliceIndex} x={slice.x} y={slice.y}
                        width={slice.width} height={slice.height}
                        viewBox={`${cropX + slice.sourceX * sourceWidth} ${cropY} ${slice.sourceWidth * sourceWidth} ${sourceHeight}`}
                        preserveAspectRatio="none" overflow="hidden">
                        <image href={presentationSlide} width="240" height="180" preserveAspectRatio="none" />
                      </svg>
                    ))}
                  </g>
                  <polygon points={quad} fill="none" stroke="#ffffff" strokeOpacity=".25" strokeWidth=".4" />
                </g>
              );
            }
            return (
              <g key={layer.id} data-preview-layer={layer.id}
                transform={`translate(${x} ${y})`}>
                <defs>
                  <clipPath id={id}>
                    <rect width={w} height={h} />
                  </clipPath>
                </defs>
                <rect x="-.5" y="1.5" width={w + 1} height={h + 1}
                  rx="2" fill="#000000" opacity=".3" />
                <g clipPath={`url(#${id})`}>
                  <g transform={`scale(${w / 240} ${h / 135})`}>
                    <ScreenArtwork id={id} />
                  </g>
                </g>
              </g>
            );
          }

          const align = getLayerTextAlign(layer, scene.layout);
          if (layer.kind === "timer") {
            const fs = Math.min(getLayerFontSize(layer, scene.layout) / 8, h / 1.57, w / ((minutes.length + 2) * .61 + 1.1));
            const pw = Math.min(w, fs * ((minutes.length + 2) * .61 + 1.16));
            const ph = Math.min(h, fs * 1.57);
            const px = align === "left" ? x : align === "right" ? x + w - pw : x + (w - pw) / 2;
            const py = y + (h - ph) / 2;
            const label = layer.text ?? (seconds > 0 ? "COMEÇAMOS EM" : "A SUA HORA CHEGOU");
            const labelWidth = label.length * fs * .063;
            return (
              <g key={layer.id} data-preview-layer={layer.id}>
                <rect x={px} y={py} width={pw} height={ph} rx={fs * .13}
                  fill={`url(#${uid}-glass)`} stroke="#ffffff" strokeOpacity=".12" strokeWidth=".5" />
                <text x={px + pw / 2} y={py + ph * .17} textAnchor="middle"
                  fontFamily="DM Sans, sans-serif" fontSize={fs * .105} fontWeight="600" fill="#ed986f"
                  textLength={labelWidth > pw * .82 ? pw * .82 : undefined} lengthAdjust="spacingAndGlyphs">
                  {label}
                </text>
                <text x={px + pw / 2} y={py + ph * .72} textAnchor="middle"
                  fontFamily="DM Sans, sans-serif" fontWeight="450" fontSize={fs}
                  letterSpacing="-.8" fill={layer.color ?? "#fffaf4"} style={{ fontVariantNumeric: "tabular-nums" }}>
                  {minutes}<tspan fill="#ff7445">:</tspan>{remainder}
                </text>
                <g fontFamily="DM Sans, sans-serif" fontSize={fs * .075} letterSpacing=".15" fill="#a49a92" textAnchor="middle">
                  <text x={px + pw * .29} y={py + ph * .89}>MINUTOS</text>
                  <text x={px + pw * .73} y={py + ph * .89}>SEGUNDOS</text>
                </g>
              </g>
            );
          }

          const text = layer.text ?? appearance.productTitle;
          const fitted = text.length > 48 ? `${text.slice(0, 47)}…` : text;
          const fs = Math.min(getLayerFontSize(layer, scene.layout) / 8, h * .65, w / Math.max(1, fitted.length * .52));
          const tx = align === "left" ? x : align === "right" ? x + w : x + w / 2;
          return (
            <text key={layer.id} data-preview-layer={layer.id}
              x={tx} y={y + h / 2}
              textAnchor={align === "left" ? "start" : align === "right" ? "end" : "middle"}
              dominantBaseline="central" fontFamily="DM Sans, sans-serif"
              fontWeight="550" fontSize={fs} letterSpacing="-.15" fill={layer.color ?? "#f8f5f0"}>
              {fitted}
            </text>
          );
        })}
        {scene.layout === "camera-zoom" && layers.some(layer => layer.kind === "camera") && (
          <g transform="translate(10 10)">
            <rect width="31" height="14" rx="7" fill="#171717" fillOpacity=".8" stroke="#ffffff" strokeOpacity=".14" strokeWidth=".5" />
            <circle cx="8" cy="7" r="1.6" fill="#ff5b24" />
            <text x="20" y="9.5" textAnchor="middle" fontFamily="DM Sans, sans-serif" fontSize="6.5" fontWeight="600" fill="#f5f3ef">
              {zoom.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}×
            </text>
          </g>
        )}
      </svg>
    </div>
  );
});
