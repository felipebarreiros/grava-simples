import type { RecordingFile } from "../media/types";
import { parseCloudTranscript, type Transcript } from "./transcript.ts";

export type GetSessionToken = () => Promise<string | null>;
export interface CloudTranscription {
  configured: boolean;
  status:
    | "idle"
    | "uploading"
    | "queued"
    | "processing"
    | "completed"
    | "error";
  maxUploadBytes: number;
  maxAudioSeconds?: number;
  jobId?: string;
  transcript?: Transcript;
  noSpeech?: boolean;
  error?: string;
}
export class TranscriptionRequestError extends Error {
  status: number;
  retryAfter: number;
  constructor(message: string, status: number, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
const endpoint = (id: string) =>
  `/api/transcriptions?recordingId=${encodeURIComponent(id)}`;
const receiptKey = (userId: string, id: string) =>
  `grava-cloud-transcription-v1:${userId}:${id}`;
const replacementKey = (userId: string, id: string) =>
  `grava-cloud-replacement-v1:${userId}:${id}`;
export type AutomaticTranscriptionAttempt = "started" | "cancelled" | "removed";
const automaticKey = (userId: string, id: string) =>
  `grava-auto-transcription-v1:${userId}:${id}`;
const automaticAttempts = new Map<string, AutomaticTranscriptionAttempt>();

/** Device intent only; actual job authorization and idempotency belong to the API. */
export function automaticTranscriptionAttempt(userId: string, id: string): AutomaticTranscriptionAttempt | null {
  const key = automaticKey(userId, id);
  try {
    const stored = localStorage.getItem(key);
    if (stored === "started" || stored === "cancelled" || stored === "removed") return stored;
  } catch { /* The in-memory marker still prevents duplicate effects when storage is full. */ }
  return automaticAttempts.get(key) ?? null;
}
export function markAutomaticTranscription(userId: string, id: string, state: AutomaticTranscriptionAttempt): void {
  const key = automaticKey(userId, id);
  automaticAttempts.set(key, state);
  try { localStorage.setItem(key, state); } catch { /* Transcription does not depend on device storage availability. */ }
}
export async function claimAutomaticTranscription(userId: string, id: string): Promise<boolean> {
  const claim = () => {
    if (automaticTranscriptionAttempt(userId, id)) return false;
    markAutomaticTranscription(userId, id, "started");
    return true;
  };
  // A short device lock makes the intent check atomic across tabs; it is never
  // held while uploading or waiting for a speech provider.
  if (typeof globalThis.navigator?.locks?.request === "function") {
    try { return await navigator.locks.request(automaticKey(userId, id), claim); }
    catch { /* A browser may expose Web Locks while device policy denies it. */ }
  }
  return claim();
}
export function rememberCloudTranscription(userId: string, id: string): void {
  localStorage.setItem(receiptKey(userId, id), "1");
}
export function hasCloudTranscription(userId: string, id: string): boolean {
  return localStorage.getItem(receiptKey(userId, id)) === "1";
}
/** A creator approved replacing local text; bind the intent once submission returns a job ID. */
export function approveCloudReplacement(
  userId: string,
  id: string,
  jobId?: string,
): void {
  localStorage.setItem(
    replacementKey(userId, id),
    JSON.stringify({ approved: true, ...(jobId ? { jobId } : {}) }),
  );
}
export function shouldReplaceCloudTranscript(
  userId: string,
  id: string,
  jobId?: string,
): boolean {
  try {
    const approval = JSON.parse(
      localStorage.getItem(replacementKey(userId, id)) || "null",
    );
    return (
      approval?.approved === true &&
      (approval.jobId === undefined ||
        (typeof approval.jobId === "string" && approval.jobId === jobId))
    );
  } catch {
    return false;
  }
}
export function clearCloudReplacement(userId: string, id: string): void {
  localStorage.removeItem(replacementKey(userId, id));
}

async function authorizedRequest(
  url: string,
  getToken: GetSessionToken,
  options: RequestInit = {},
): Promise<Response> {
  options.signal?.throwIfAborted();
  const token = await getToken();
  options.signal?.throwIfAborted();
  if (!token)
    throw new TranscriptionRequestError(
      "Entre novamente para transcrever esta gravação.",
      401,
    );
  return fetch(url, {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
}

async function readState(response: Response): Promise<CloudTranscription> {
  if (!response.headers.get("content-type")?.includes("application/json")) {
    if (response.status === 404 || response.ok)
      return { configured: false, status: "idle", maxUploadBytes: 0 };
    throw new TranscriptionRequestError(
      "O serviço de transcrição está indisponível. Tente novamente.",
      response.status,
    );
  }
  const body = await response.json();
  if (!response.ok) {
    const message =
      response.status === 401
        ? "Entre novamente para transcrever esta gravação."
        : response.status === 429
          ? "Limite de transcrições atingido. Aguarde antes de tentar novamente."
          : typeof body.error === "string"
            ? body.error
            : "Não foi possível concluir a transcrição. Tente novamente.";
    throw new TranscriptionRequestError(
      message,
      response.status,
      Math.max(0, Number(response.headers.get("retry-after")) || 0),
    );
  }
  const states = [
    "idle",
    "uploading",
    "queued",
    "processing",
    "completed",
    "error",
  ];
  if (typeof body.configured !== "boolean" || !states.includes(body.status))
    throw new Error("O serviço retornou um estado de transcrição inválido.");
  return {
    ...body,
    transcript: body.transcript
      ? parseCloudTranscript(body.transcript)
      : undefined,
  };
}

export async function getCloudTranscription(
  recordingId: string,
  getToken: GetSessionToken,
  signal?: AbortSignal,
): Promise<CloudTranscription> {
  return readState(
    await authorizedRequest(endpoint(recordingId), getToken, { signal }),
  );
}

export async function deleteCloudTranscription(
  recordingId: string,
  getToken: GetSessionToken,
  signal?: AbortSignal,
  userId?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    signal?.throwIfAborted();
    const response = await authorizedRequest(endpoint(recordingId), getToken, {
      method: "DELETE",
      signal,
    });
    if (response.status === 409 && attempt < 3) {
      const retryAfter = response.headers.get("retry-after");
      const requestedDelay =
        retryAfter === null ? Number.NaN : Number(retryAfter);
      const delaySeconds =
        Number.isFinite(requestedDelay) && requestedDelay >= 0
          ? Math.min(requestedDelay, 3)
          : 3;
      await waitForRetry(delaySeconds * 1000, signal);
      continue;
    }
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new TranscriptionRequestError(
        "Não foi possível confirmar a exclusão da transcrição. O serviço está indisponível.",
        response.ok ? 502 : response.status,
      );
    }
    const state = await readState(response);
    signal?.throwIfAborted();
    if (
      response.status !== 200 ||
      state.configured !== true ||
      state.status !== "idle"
    ) {
      throw new TranscriptionRequestError(
        "O serviço não confirmou a exclusão da transcrição. Tente novamente.",
        502,
      );
    }
    if (userId) {
      localStorage.removeItem(receiptKey(userId, recordingId));
      clearCloudReplacement(userId, recordingId);
    }
    return;
  }
}

function waitForRetry(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function startCloudTranscription({
  recordingId,
  userId,
  file,
  getToken,
  signal,
  onProgress,
}: {
  recordingId: string;
  userId: string;
  file: RecordingFile;
  getToken: GetSessionToken;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}): Promise<CloudTranscription> {
  const state = await getCloudTranscription(recordingId, getToken, signal);
  if (!state.configured)
    throw new Error(
      "A transcrição está indisponível no momento. Tente novamente mais tarde.",
    );
  if (
    state.status === "queued" ||
    state.status === "processing" ||
    state.status === "completed"
  )
    return state;
  if (file.size > state.maxUploadBytes)
    throw new Error(
      `Esta gravação excede o limite de ${Math.floor(state.maxUploadBytes / 1024 / 1024)} MB para transcrição.`,
    );
  if (file.durationMs / 1000 > (state.maxAudioSeconds ?? 7200))
    throw new Error(
      "A transcrição automática aceita gravações de até duas horas nesta versão.",
    );
  if (!/^video\/(mp4|webm)(?:;|$)/.test(file.mimeType))
    throw new Error("Escolha uma gravação MP4 ou WebM para transcrever.");
  const token = await getToken();
  if (!token)
    throw new TranscriptionRequestError(
      "Entre novamente para transcrever esta gravação.",
      401,
    );
  const extension = file.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
  const { upload } = await import("@vercel/blob/client");
  let uploaded = false;
  try {
    rememberCloudTranscription(userId, recordingId);
    const blob = await upload(
      `transcriptions/${userId}/${recordingId}/${crypto.randomUUID()}.${extension}`,
      file.blob,
      {
        access: "private",
        multipart: true,
        contentType: file.mimeType.split(";")[0].trim(),
        handleUploadUrl: "/api/transcription-upload",
        clientPayload: JSON.stringify({ recordingId }),
        headers: { Authorization: `Bearer ${token}` },
        abortSignal: signal,
        onUploadProgress: (progress) => onProgress?.(progress.percentage),
      },
    );
    uploaded = true;
    return await readState(
      await authorizedRequest("/api/transcriptions", getToken, {
        // Once upload finishes, leaving the page must not cancel job submission.
        // Explicit cancellation still removes the job through the DELETE endpoint.
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId, blobUrl: blob.url }),
      }),
    );
  } catch (error) {
    // Cancellation/failed submission leaves no intentional permanent cloud copy.
    // The scheduled server cleanup remains the fallback if this request cannot run.
    if (uploaded) {
      try {
        const pending = await getCloudTranscription(recordingId, getToken);
        if (["queued", "processing", "completed"].includes(pending.status))
          return pending;
      } catch {
        /* Scheduled cleanup also covers a lost submit response. */
      }
    }
    if (uploaded || signal?.aborted)
      await deleteCloudTranscription(
        recordingId,
        getToken,
        undefined,
        userId,
      ).catch(() => {});
    throw error;
  }
}
