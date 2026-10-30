import { ApiError } from "./security.ts";
import type {
  AutomaticTranscript,
  ProviderTranscript,
  TimedWord,
} from "./types.ts";
import { MAX_AUDIO_MS, MAX_RESPONSE_BYTES } from "./types.ts";

/** Preserve actual ASR word boundaries; phrase grouping never invents alignment. */
export function normalizeTranscript(
  source: ProviderTranscript,
  now: number,
): { transcript?: AutomaticTranscript; noSpeech?: boolean } {
  if (!source.words?.length) {
    if (source.text?.trim())
      throw new ApiError(
        502,
        "A transcrição não trouxe os tempos das palavras. Tente novamente.",
      );
    return { noSpeech: true };
  }
  if (source.words.length > 40_000)
    throw new ApiError(502, "A transcrição excedeu o limite desta versão.");
  let previous = -1;
  const words: TimedWord[] = source.words.map((word, index) => {
    if (
      !word ||
      typeof word.text !== "string" ||
      !word.text.trim() ||
      word.text.length > 1000 ||
      !Number.isFinite(word.start) ||
      !Number.isFinite(word.end) ||
      word.start < 0 ||
      word.start >= MAX_AUDIO_MS ||
      word.start < previous ||
      word.end <= word.start ||
      word.end > MAX_AUDIO_MS + 250
    ) {
      throw new ApiError(
        502,
        "O serviço retornou tempos de transcrição inválidos. Tente novamente.",
      );
    }
    previous = word.start;
    return {
      id: `word-${index + 1}`,
      text: word.text.trim(),
      start: word.start / 1000,
      end: Math.min(word.end, MAX_AUDIO_MS) / 1000,
    };
  });
  const cues: AutomaticTranscript["cues"] = [];
  let group: TimedWord[] = [];
  let groupCharacters = 0;
  const flush = () => {
    if (!group.length) return;
    cues.push({
      id: `cue-${cues.length + 1}`,
      start: group[0].start,
      end: group[group.length - 1].end,
      text: group
        .map((word) => word.text)
        .join(" ")
        .replace(/\s+([,.;:!?])/g, "$1"),
    });
    group = [];
    groupCharacters = 0;
  };
  for (const word of words) {
    if (
      group.length &&
      (word.start - group[group.length - 1].end > 1.5 ||
        word.end - group[0].start > 12 ||
        groupCharacters + word.text.length + 1 > 8000 ||
        group.length >= 24)
    )
      flush();
    group.push(word);
    groupCharacters += word.text.length + 1;
    if (/[.!?]["'”’)]?$/.test(word.text)) flush();
  }
  flush();
  if (cues.length > 20_000) throw new ApiError(502, 'A transcrição excedeu o limite desta versão.');
  const transcript: AutomaticTranscript = {
    version: 1,
    origin: "automatic",
    provider: "assemblyai",
    sourceName: "Transcrição automática",
    importedAt: now,
    updatedAt: now,
    ...(typeof source.language_code === "string"
      ? { language: source.language_code }
      : {}),
    cues,
    words,
  };
  if (
    Buffer.byteLength(JSON.stringify(transcript), "utf8") >
    MAX_RESPONSE_BYTES - 10_000
  )
    throw new ApiError(502, "A transcrição excedeu o limite desta versão.");
  return { transcript };
}
