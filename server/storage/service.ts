import { ApiError } from "../transcription/security.ts";
import { MAX_STORAGE_BYTES, publicRecording, type StoredRecording, type StorageDependencies } from "./types.ts";
import { validateStoredTranscript } from "./transcript.ts";
import { orientation, recordingId, validateMetadata } from "./validation.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Authorization", "X-Content-Type-Options": "nosniff" } });
export function storageError(error: unknown): Response {
  const known = error instanceof ApiError;
  const response = json({ error: known ? error.message : "Não foi possível acessar suas gravações na nuvem. Tente novamente." }, known ? error.status : 503);
  if (known && error.retryAfter) response.headers.set("Retry-After", String(error.retryAfter));
  return response;
}
async function owned(deps: StorageDependencies, userId: string, id: string): Promise<StoredRecording> {
  const recording = await deps.repository.get(userId, id);
  // Defense beyond database RLS: a repository returning an unexpected owner fails closed.
  if (!recording || recording.ownerId !== userId) throw new ApiError(404, "Gravação não encontrada.");
  return recording;
}
function validObject(blob: { pathname: string; url: string; size: number; contentType: string }, asset: StoredRecording["assets"][number]): boolean {
  try {
    const url = new URL(blob.url);
    return blob.pathname === asset.pathname && blob.size === asset.expectedBytes && blob.contentType.split(";")[0].trim().toLowerCase() === asset.contentType && url.protocol === "https:" && /^[a-z0-9]+\.private\.blob\.vercel-storage\.com$/i.test(url.hostname) && decodeURIComponent(url.pathname.slice(1)) === asset.pathname;
  } catch { return false; }
}
export async function handleRecordings(request: Request, deps: StorageDependencies): Promise<Response> {
  try {
    if (!["GET", "POST", "DELETE"].includes(request.method)) throw new ApiError(405, "Método não permitido.");
    const { userId } = await deps.authenticate(request);
    const url = new URL(request.url);
    if (!deps.configured) {
      if (request.method === "GET" && !url.searchParams.has("recordingId")) return json({ configured: false, recordings: [], maxStorageBytes: MAX_STORAGE_BYTES, usedBytes: 0 });
      throw new ApiError(503, "O armazenamento na nuvem ainda não foi configurado.");
    }
    await deps.quota(userId, "request");
    if (request.method === "GET") {
      const rawId = url.searchParams.get("recordingId");
      if ((url.searchParams.get("cursor")?.length ?? 0) > 300) throw new ApiError(400, "A página de gravações é inválida.");
      if (!rawId) return json({ configured: true, ...await deps.repository.list(userId, url.searchParams.get("cursor")), maxStorageBytes: MAX_STORAGE_BYTES });
      const recording = await owned(deps, userId, recordingId(rawId));
      if (recording.status !== "ready") throw new ApiError(409, "O envio desta gravação ainda não foi concluído.");
      if (url.searchParams.get("transcript") === "1") return json(await deps.repository.getTranscript(userId, recording.id));
      const selected = orientation(url.searchParams.get("orientation"));
      const asset = recording.assets.find(asset => asset.orientation === selected);
      if (!asset) throw new ApiError(404, "Vídeo não encontrado.");
      return json(await deps.blob.signedGet(asset.pathname));
    }
    if (request.method === "DELETE") {
      const id = recordingId(url.searchParams.get("recordingId"));
      // Unknown/other-account identifiers have the same idempotent response and no Blob access.
      const before = await deps.repository.get(userId, id);
      if (!before || before.ownerId !== userId) return json({ deleted: true });
      const record = await deps.repository.markDeleting(userId, id);
      if (record && record.ownerId === userId) {
        await deps.blob.delete(record.assets.map(asset => asset.pathname));
        await deps.repository.remove(userId, id);
      }
      return json({ deleted: true });
    }
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ApiError(415, "Envie os dados em JSON.");
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 3_800_000) throw new ApiError(413, "Os dados desta gravação são grandes demais.");
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); } catch { throw new ApiError(400, "Dados inválidos."); }
    if (body.action === "reserve") {
      if (text.length > 100_000) throw new ApiError(413, "Os dados desta gravação são grandes demais.");
      await deps.quota(userId, "reserve");
      const metadata = validateMetadata(body.take, body.projectName);
      const recording = await deps.repository.reserve(userId, metadata);
      if (recording.ownerId !== userId) throw new ApiError(404, "Gravação não encontrada.");
      const uploads: Record<string, { pathname: string; uploaded: boolean }> = {};
      for (const asset of recording.assets) {
        let uploaded = recording.status === "ready";
        if (!uploaded) {
          try { uploaded = validObject(await deps.blob.head(asset.pathname), asset); } catch { /* Missing object: the browser can upload it. */ }
        }
        uploads[asset.orientation] = { pathname: asset.pathname, uploaded };
      }
      return json({ recording: publicRecording(recording), uploads });
    }
    if (body.action === "transcript") {
      const recording = await owned(deps, userId, recordingId(body.recordingId));
      if (recording.status !== "ready") throw new ApiError(409, "Conclua o envio da gravação antes de salvar sua transcrição.");
      if (typeof body.expectedVersion !== "number" || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0) throw new ApiError(400, "A versão da transcrição é inválida.");
      const transcript = validateStoredTranscript(body.transcript, recording.metadata.durationMs);
      return json(await deps.repository.saveTranscript(userId, recording.id, transcript, body.expectedVersion));
    }
    if (body.action === "finalize") {
      const id = recordingId(body.recordingId);
      const recording = await owned(deps, userId, id);
      if (recording.status === "ready") return json({ recording: publicRecording(recording) });
      if (recording.status !== "pending" || recording.expiresAt <= deps.now()) throw new ApiError(409, "Este envio expirou ou foi removido.");
      if (recording.assets.length !== 2 || new Set(recording.assets.map(asset => asset.orientation)).size !== 2) throw new ApiError(409, "Os dois formatos precisam ser enviados.");
      for (const asset of recording.assets) {
        let blob;
        try { blob = await deps.blob.head(asset.pathname); } catch { throw new ApiError(409, "O envio dos dois formatos ainda não foi concluído."); }
        if (!validObject(blob, asset)) throw new ApiError(409, "O arquivo enviado não corresponde a esta gravação.");
      }
      return json({ recording: publicRecording(await deps.repository.complete(userId, id)) });
    }
    throw new ApiError(400, "Ação inválida.");
  } catch (error) { return storageError(error); }
}

export async function grantRecordingUpload(deps: StorageDependencies, userId: string, pathname: string, clientPayload: string | null) {
  if (!clientPayload || clientPayload.length > 1024) throw new ApiError(400, "Dados de envio inválidos.");
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(clientPayload); } catch { throw new ApiError(400, "Dados de envio inválidos."); }
  const id = recordingId(payload?.recordingId), selected = orientation(payload?.orientation);
  const recording = await owned(deps, userId, id);
  if (recording.status !== "pending" || recording.expiresAt <= deps.now()) throw new ApiError(409, "Este envio expirou ou já foi concluído.");
  const asset = recording.assets.find(asset => asset.orientation === selected);
  if (!asset || asset.pathname !== pathname || !pathname.startsWith(`recordings/${userId}/${recording.id}/`)) throw new ApiError(403, "Este arquivo não pertence ao envio autorizado.");
  await deps.quota(userId, "upload");
  return { maximumSizeInBytes: asset.expectedBytes, allowedContentTypes: [asset.contentType], validUntil: Math.min(recording.expiresAt, deps.now() + 15 * 60 * 1000), addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60 };
}
