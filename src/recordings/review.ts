import { scopedLocalKey } from "../projects/keys.ts";

export interface RecordingMarker {
  id: string;
  time: number;
  text: string;
}
export interface RecordingReview {
  version: 1;
  markers: RecordingMarker[];
}
const key = (id: string) => scopedLocalKey(`grava-recording-review-v1:${id}`);

export function loadReview(id: string): RecordingReview {
  const empty: RecordingReview = { version: 1, markers: [] };
  try {
    const value = JSON.parse(localStorage.getItem(key(id)) || "null");
    if (value?.version !== 1 || !Array.isArray(value.markers)) return empty;
    return {
      version: 1,
      markers: value.markers
        .filter(
          (marker: RecordingMarker) =>
            typeof marker.id === "string" &&
            Number.isFinite(marker.time) &&
            marker.time >= 0 &&
            typeof marker.text === "string" &&
            marker.text.length <= 1000,
        )
        .slice(0, 1000)
        .sort((a: RecordingMarker, b: RecordingMarker) => a.time - b.time),
    };
  } catch {
    return empty;
  }
}

export function saveReview(
  id: string,
  review: RecordingReview,
): RecordingReview {
  if (review.markers.length > 1000)
    throw new Error("O limite é de 1.000 marcadores por gravação.");
  const next: RecordingReview = {
    version: 1,
    markers: [...review.markers].sort((a, b) => a.time - b.time),
  };
  try {
    localStorage.setItem(key(id), JSON.stringify(next));
  } catch {
    throw new Error(
      "Não foi possível salvar os marcadores. Verifique o espaço disponível neste navegador.",
    );
  }
  return next;
}

export function deleteReview(id: string): void {
  localStorage.removeItem(key(id));
}
