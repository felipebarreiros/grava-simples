export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_AUDIO_MS = 2 * 60 * 60 * 1000;
export const JOB_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const MAX_RESPONSE_BYTES = 3_800_000;
export const ALLOWED_CONTENT_TYPES = [
  "video/mp4",
  "video/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/webm",
  "audio/wav",
  "audio/x-wav",
];

export interface TimedWord {
  id: string;
  text: string;
  start: number;
  end: number;
}
export interface AutomaticTranscript {
  version: 1;
  origin: "automatic";
  provider: "assemblyai";
  sourceName: string;
  importedAt: number;
  updatedAt: number;
  language?: string;
  cues: Array<{ id: string; text: string; start: number; end: number }>;
  words: TimedWord[];
}
export type JobStatus =
  | "uploading"
  | "submitting"
  | "queued"
  | "processing"
  | "completed"
  | "error"
  | "deleted";
export interface TranscriptionJob {
  userId: string;
  recordingId: string;
  status: JobStatus;
  pathname: string;
  blobPaths: string[];
  providerIds: string[];
  providerId?: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  transcript?: AutomaticTranscript;
  noSpeech?: boolean;
  error?: string;
}
export interface ProviderTranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  language_code?: string | null;
  audio_duration?: number | null;
  words?: Array<{ text: string; start: number; end: number }> | null;
}
export interface JobRepository {
  get(userId: string, recordingId: string): Promise<TranscriptionJob | null>;
  save(job: TranscriptionJob): Promise<void>;
  acquire(userId: string, recordingId: string): Promise<string | null>;
  release(userId: string, recordingId: string, token: string): Promise<void>;
  due(
    now: number,
    limit: number,
  ): Promise<Array<{ userId: string; recordingId: string }>>;
  remove(userId: string, recordingId: string): Promise<void>;
}
export interface TranscriptionDependencies {
  configured: boolean;
  authenticate(request: Request): Promise<{ userId: string }>;
  quota(
    userId: string,
    action: "poll" | "submit" | "upload" | "delete",
  ): Promise<unknown>;
  repository: JobRepository;
  blob: {
    head(
      pathname: string,
    ): Promise<{
      pathname: string;
      url: string;
      size: number;
      contentType: string;
    }>;
    signedGet(pathname: string): Promise<string>;
    delete(pathnames: string[]): Promise<void>;
  };
  provider: {
    submit(audioUrl: string): Promise<ProviderTranscript>;
    get(id: string): Promise<ProviderTranscript>;
    delete(id: string): Promise<void>;
  };
  now(): number;
}
