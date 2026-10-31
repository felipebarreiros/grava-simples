import { ApiError } from "../transcription/security.ts";

const invalid = () => new ApiError(400, "A transcrição contém dados inválidos.");
/** Explicit projection prevents arbitrary metadata, credentials or unbounded objects being stored. */
export function validateStoredTranscript(value: unknown, durationMs: number): Record<string, unknown> | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const text = (value: unknown, limit: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\u0000")) throw invalid();
    return value;
  };
  const time = (value: unknown, limit: number) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > limit) throw invalid();
    return value;
  };
  if (input.version !== 1 || !Array.isArray(input.cues) || !input.cues.length || input.cues.length > 20_000) throw invalid();
  const result: Record<string, unknown> = { version: 1, sourceName: text(input.sourceName, 160), importedAt: time(input.importedAt, Date.now() + 86_400_000), updatedAt: time(input.updatedAt, Date.now() + 86_400_000) };
  if (input.origin !== undefined) { if (input.origin !== "import" && input.origin !== "automatic") throw invalid(); result.origin = input.origin; }
  if (input.provider !== undefined) result.provider = text(input.provider, 100);
  if (input.language !== undefined) result.language = text(input.language, 30);
  const maxTime = durationMs / 1000 + 1;
  function entries(values: unknown[], words: boolean) {
    let previousStart = -1;
    const ids = new Set<string>();
    return values.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
      const entry = value as Record<string, unknown>;
      const id = text(entry.id, 128), start = time(entry.start, maxTime), end = time(entry.end, maxTime);
      if (ids.has(id) || start < previousStart || (words ? end < start : end <= start)) throw invalid();
      ids.add(id); previousStart = start;
      const output: Record<string, unknown> = { id, start, end, text: text(entry.text, words ? 1000 : 10_000) };
      if (!words && entry.originalText !== undefined) output.originalText = text(entry.originalText, 10_000);
      return output;
    });
  }
  result.cues = entries(input.cues, false);
  if (input.words !== undefined) {
    if (!Array.isArray(input.words) || input.words.length > 100_000) throw invalid();
    result.words = entries(input.words, true);
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 3_800_000) throw new ApiError(413, "A transcrição é grande demais para salvar na nuvem.");
  return result;
}
