import { ApiError } from "../transcription/security.ts";
import { MAX_RECORDING_BYTES, type RecordingMetadata, type SavedFile, type Orientation } from "./types.ts";

const invalid = () => new ApiError(400, "Os dados desta gravação são inválidos.");
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw invalid();
  return value.trim();
};
function number(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) throw invalid();
  return value;
}
function file(value: unknown): SavedFile {
  if (!value || typeof value !== "object") throw invalid();
  const item = value as Record<string, unknown>;
  const mimeType = text(item.mimeType, 120).split(";")[0].trim().toLowerCase();
  if (!["video/mp4", "video/webm"].includes(mimeType)) throw invalid();
  const size = number(item.size, MAX_RECORDING_BYTES);
  if (!Number.isSafeInteger(size) || size < 1) throw invalid();
  return { fileName: text(item.fileName, 160).replace(/[\\/]/g, "_"), mimeType, size };
}
export function validateMetadata(take: unknown, projectName: unknown): RecordingMetadata {
  if (!take || typeof take !== "object" || Array.isArray(take)) throw invalid();
  const item = take as Record<string, unknown>;
  const id = text(item.id, 128), projectId = text(item.projectId, 128);
  if (!/^[\w-]+$/.test(id) || !/^[\w-]+$/.test(projectId)) throw invalid();
  const durationMs = number(item.durationMs, 24 * 60 * 60 * 1000);
  const maxDate = Date.now() + 24 * 60 * 60 * 1000;
  const createdAt = number(item.createdAt, maxDate), startedAt = number(item.startedAt, maxDate), stoppedAt = number(item.stoppedAt, maxDate);
  if (stoppedAt < startedAt) throw invalid();
  const result: RecordingMetadata = {
    id, projectId, projectName: text(projectName, 80), name: text(item.name, 80), createdAt, startedAt, stoppedAt, durationMs,
    warnings: Array.isArray(item.warnings) ? item.warnings.slice(0, 20).map(value => text(value, 500)) : [],
    landscape: file(item.landscape), portrait: file(item.portrait),
  };
  if (item.thumbnail !== undefined) {
    if (typeof item.thumbnail !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(item.thumbnail) || item.thumbnail.length > 64_000) throw invalid();
    result.thumbnail = item.thumbnail;
    result.thumbnailAtSeconds = number(item.thumbnailAtSeconds ?? 0, durationMs / 1000 + 1);
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 90_000) throw new ApiError(413, "Os dados desta gravação são grandes demais.");
  return result;
}
export function recordingId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw invalid();
  return value;
}
export function orientation(value: unknown): Orientation {
  if (value !== "landscape" && value !== "portrait") throw invalid();
  return value;
}
