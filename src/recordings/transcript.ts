import { scopedLocalKey } from "../projects/keys.ts";

/** Local timed captions. Times always come from the imported subtitle file. */
export interface TranscriptCue {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Retained when the creator corrects the wording; media timings stay intact. */
  originalText?: string;
}

/** Speech-provider alignment in source time; never derived from caption length. */
export interface TranscriptWord {
  id: string;
  text: string;
  start: number;
  end: number;
}

export interface Transcript {
  version: 1;
  sourceName: string;
  importedAt: number;
  updatedAt: number;
  cues: TranscriptCue[];
  origin?: "import" | "automatic";
  provider?: string;
  language?: string;
  words?: TranscriptWord[];
}

export const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
export const MAX_TRANSCRIPT_CUES = 20_000;
export const TRANSCRIPT_STORAGE_PREFIX = "grava-simples-transcript-v1:";
const MAX_CUE_TEXT = 10_000;
const MAX_TIMESTAMP = 7 * 24 * 60 * 60;

function subtitleTime(value: string): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!match)
    throw new Error(
      `Tempo inválido na legenda: “${value}”. Use horas, minutos, segundos e milissegundos.`,
    );
  const seconds =
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000;
  if (!Number.isFinite(seconds) || seconds > MAX_TIMESTAMP)
    throw new Error("A legenda contém um tempo fora do limite de sete dias.");
  return seconds;
}

function plainSubtitleText(value: string): string {
  return value
    .replace(
      /<\/?(?:b|i|u|c(?:\.[\w.-]+)?|ruby|rt|v(?:\s[^>]*)?|lang(?:\s[^>]*)?|font(?:\s[^>]*)?)>/gi,
      "",
    )
    .replace(/<(?:(?:\d{2,}):)?[0-5]\d:[0-5]\d\.\d{3}>/g, "")
    .replace(
      /&(amp|lt|gt|nbsp|lrm|rlm|quot|apos);/g,
      (_match, entity: string) =>
        ({
          amp: "&",
          lt: "<",
          gt: ">",
          nbsp: " ",
          lrm: "\u200e",
          rlm: "\u200f",
          quot: '"',
          apos: "'",
        })[entity] ?? "",
    )
    .replace(/\u0000/g, "")
    .trim();
}

/** Parse SRT or WebVTT without guessing word boundaries or word timestamps. */
export function parseTranscript(
  text: string,
  options: { fileName?: string; durationSeconds?: number } = {},
): Transcript {
  if (new TextEncoder().encode(text).byteLength > MAX_TRANSCRIPT_BYTES)
    throw new Error("A legenda deve ter até 5 MB.");
  const normalized = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const webVtt = /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(normalized);
  const blocks = normalized.split(/\n[ \t]*\n+/);
  if (webVtt) blocks.shift(); // The WebVTT header may include metadata before its blank line.
  const cues: TranscriptCue[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    if (
      webVtt &&
      /^(?:NOTE(?:[ \t\n]|$)|STYLE(?:[ \t\n]|$)|REGION(?:[ \t\n]|$))/.test(
        block,
      )
    )
      continue;
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0 || timingIndex > 1)
      throw new Error(
        "Não foi possível ler a legenda. Escolha um arquivo SRT ou WebVTT com tempos válidos.",
      );
    const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)(?:[ \t]+.*)?$/.exec(
      lines[timingIndex].trim(),
    );
    if (!timing)
      throw new Error(
        `Linha de tempo inválida na legenda: “${lines[timingIndex].slice(0, 120)}”.`,
      );
    const start = subtitleTime(timing[1]);
    let end = subtitleTime(timing[2]);
    if (end <= start)
      throw new Error(
        "Cada trecho da legenda precisa terminar depois de começar.",
      );
    const duration = options.durationSeconds;
    if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
      if (start >= duration || end > duration + 0.25)
        throw new Error(
          "Os tempos da legenda ultrapassam a duração desta gravação. Escolha a legenda correspondente a este vídeo.",
        );
      end = Math.min(end, duration); // Accommodate container/subtitle rounding at the final frame.
    }
    const content = plainSubtitleText(lines.slice(timingIndex + 1).join("\n"));
    if (!content) throw new Error("A legenda contém um trecho sem texto.");
    if (content.length > MAX_CUE_TEXT)
      throw new Error(
        "Um trecho da legenda excede o limite de 10.000 caracteres.",
      );
    cues.push({ id: `cue-${cues.length + 1}`, start, end, text: content });
    if (cues.length > MAX_TRANSCRIPT_CUES)
      throw new Error("A legenda deve ter no máximo 20.000 trechos.");
  }
  if (!cues.length)
    throw new Error(
      "Nenhum trecho com tempo foi encontrado. Escolha um arquivo SRT ou WebVTT.",
    );
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  const now = Date.now();
  return {
    version: 1,
    sourceName: (
      options.fileName?.trim() || (webVtt ? "Legenda WebVTT" : "Legenda SRT")
    ).slice(0, 255),
    importedAt: now,
    updatedAt: now,
    cues,
  };
}

export async function importTranscriptFile(
  file: File,
  durationSeconds?: number,
): Promise<Transcript> {
  if (!/\.(?:srt|vtt)$/i.test(file.name))
    throw new Error("Escolha um arquivo .srt ou .vtt.");
  if (file.size > MAX_TRANSCRIPT_BYTES)
    throw new Error("A legenda deve ter até 5 MB.");
  return parseTranscript(await file.text(), {
    fileName: file.name,
    durationSeconds,
  });
}

function validTranscript(value: unknown): value is Transcript {
  if (!value || typeof value !== "object") return false;
  const item = value as Transcript;
  if (
    item.version !== 1 ||
    typeof item.sourceName !== "string" ||
    item.sourceName.length > 255 ||
    !Number.isFinite(item.importedAt) ||
    !Number.isFinite(item.updatedAt) ||
    !Array.isArray(item.cues) ||
    !item.cues.length ||
    item.cues.length > MAX_TRANSCRIPT_CUES ||
    (item.origin !== undefined &&
      !["import", "automatic"].includes(item.origin)) ||
    (item.provider !== undefined &&
      (typeof item.provider !== "string" || item.provider.length > 100)) ||
    (item.language !== undefined &&
      (typeof item.language !== "string" || item.language.length > 30))
  )
    return false;
  if (item.words !== undefined) {
    if (!Array.isArray(item.words) || item.words.length > 100_000) return false;
    let previousWordStart = -1;
    const wordIds = new Set<string>();
    if (
      !item.words.every((word) => {
        if (
          !word ||
          typeof word.id !== "string" ||
          !word.id ||
          wordIds.has(word.id) ||
          typeof word.text !== "string" ||
          !word.text.trim() ||
          word.text.length > 1000 ||
          !Number.isFinite(word.start) ||
          !Number.isFinite(word.end) ||
          word.start < 0 ||
          word.start < previousWordStart ||
          word.end < word.start ||
          word.end > MAX_TIMESTAMP
        )
          return false;
        previousWordStart = word.start;
        wordIds.add(word.id);
        return true;
      })
    )
      return false;
  }
  let previousStart = -1;
  const ids = new Set<string>();
  return item.cues.every((cue) => {
    if (
      !cue ||
      typeof cue.id !== "string" ||
      !cue.id ||
      ids.has(cue.id) ||
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      cue.start < 0 ||
      cue.end <= cue.start ||
      cue.end > MAX_TIMESTAMP ||
      cue.start < previousStart ||
      typeof cue.text !== "string" ||
      !cue.text.trim() ||
      cue.text.length > MAX_CUE_TEXT ||
      (cue.originalText !== undefined &&
        (typeof cue.originalText !== "string" ||
          cue.originalText.length > MAX_CUE_TEXT))
    )
      return false;
    ids.add(cue.id);
    previousStart = cue.start;
    return true;
  });
}

/** Validate the network response before it becomes trusted local review data. */
export function parseCloudTranscript(value: unknown): Transcript {
  if (!validTranscript(value) || value.origin !== "automatic")
    throw new Error(
      "O serviço retornou uma transcrição inválida. Tente novamente.",
    );
  return value;
}

/** Missing or malformed local data is treated as unavailable, never as generated speech. */
export function loadTranscript(takeId: string): Transcript | null {
  try {
    const stored = localStorage.getItem(scopedLocalKey(TRANSCRIPT_STORAGE_PREFIX + takeId));
    if (
      !stored ||
      new TextEncoder().encode(stored).byteLength > MAX_TRANSCRIPT_BYTES * 2
    )
      return null;
    const value: unknown = JSON.parse(stored);
    return validTranscript(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveTranscript(
  takeId: string,
  transcript: Transcript,
): Transcript {
  if (!takeId || !validTranscript(transcript))
    throw new Error(
      "A transcrição contém dados inválidos e não pôde ser salva.",
    );
  const saved = { ...transcript, updatedAt: Date.now() };
  try {
    localStorage.setItem(
      scopedLocalKey(TRANSCRIPT_STORAGE_PREFIX + takeId),
      JSON.stringify(saved),
    );
  } catch {
    throw new Error(
      "Não foi possível salvar a transcrição neste navegador. Verifique o espaço disponível e tente novamente.",
    );
  }
  return saved;
}

export function deleteTranscript(takeId: string): void {
  try {
    localStorage.removeItem(scopedLocalKey(TRANSCRIPT_STORAGE_PREFIX + takeId));
  } catch {
    throw new Error(
      "Não foi possível remover a transcrição deste navegador. Tente novamente.",
    );
  }
}

/** Correct the displayed/exported wording while retaining imported timing and original text. */
export function updateTranscriptCue(
  transcript: Transcript,
  cueId: string,
  text: string,
): Transcript {
  const corrected = text.trim();
  if (!corrected) throw new Error("O texto do trecho não pode ficar vazio.");
  if (corrected.length > MAX_CUE_TEXT)
    throw new Error("O trecho deve ter até 10.000 caracteres.");
  if (!transcript.cues.some((cue) => cue.id === cueId))
    throw new Error("Trecho da transcrição não encontrado.");
  return {
    ...transcript,
    updatedAt: Date.now(),
    cues: transcript.cues.map((cue) =>
      cue.id === cueId
        ? {
            ...cue,
            originalText: cue.originalText ?? cue.text,
            text: corrected,
          }
        : cue,
    ),
  };
}

function formatTimestamp(seconds: number, separator: "." | ","): string {
  const millis = Math.round(seconds * 1000);
  const hours = Math.floor(millis / 3_600_000);
  const minutes = Math.floor((millis % 3_600_000) / 60_000);
  const remainder = Math.floor((millis % 60_000) / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}${separator}${String(millis % 1000).padStart(3, "0")}`;
}

export function exportTranscript(
  transcript: Transcript,
  format: "vtt" | "srt" | "txt",
): string {
  if (!validTranscript(transcript))
    throw new Error(
      "A transcrição contém dados inválidos e não pôde ser exportada.",
    );
  if (format === "txt")
    return transcript.cues.map((cue) => cue.text).join("\n\n") + "\n";
  const separator = format === "vtt" ? "." : ",";
  const escaped = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cues = transcript.cues
    .map(
      (cue, index) =>
        `${format === "srt" ? `${index + 1}\n` : ""}${formatTimestamp(cue.start, separator)} --> ${formatTimestamp(cue.end, separator)}\n${escaped(cue.text)}`,
    )
    .join("\n\n");
  return `${format === "vtt" ? "WEBVTT\n\n" : ""}${cues}\n`;
}
