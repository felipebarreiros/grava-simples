import { ApiError } from "./security.ts";
import { normalizeTranscript } from "./normalize.ts";
import {
  ALLOWED_CONTENT_TYPES,
  JOB_LIFETIME_MS,
  MAX_AUDIO_MS,
  MAX_RESPONSE_BYTES,
  MAX_UPLOAD_BYTES,
  type TranscriptionDependencies,
  type TranscriptionJob,
} from "./types.ts";

export function recordingId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new ApiError(400, "Identificador de gravação inválido.");
  return value;
}

function json(value: unknown, status = 200): Response {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES)
    throw new ApiError(502, "A transcrição excedeu o limite desta versão.");
  return new Response(serialized, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      Vary: "Authorization",
    },
  });
}
export function errorResponse(error: unknown): Response {
  const known = error instanceof ApiError;
  const response = json(
    {
      error: known
        ? error.message
        : "Não foi possível acessar a transcrição. Tente novamente.",
    },
    known ? error.status : 503,
  );
  if (known && error.retryAfter)
    response.headers.set("Retry-After", String(error.retryAfter));
  return response;
}

export function jobResponse(job: TranscriptionJob | null) {
  if (!job || job.status === "deleted")
    return {
      configured: true,
      status: "idle",
      maxUploadBytes: MAX_UPLOAD_BYTES,
      maxAudioSeconds: MAX_AUDIO_MS / 1000,
    };
  return {
    configured: true,
    status: job.status === "submitting" ? "queued" : job.status,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    maxAudioSeconds: MAX_AUDIO_MS / 1000,
    ...(job.providerId ? { jobId: job.providerId } : {}),
    ...(job.transcript ? { transcript: job.transcript } : {}),
    ...(job.noSpeech ? { noSpeech: true } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/** Keep paths/IDs until expiry so daily cleanup retries transient delete failures. */
export async function cleanupSources(
  job: TranscriptionJob,
  deps: TranscriptionDependencies,
): Promise<boolean> {
  const results = await Promise.allSettled([
    job.blobPaths.length ? deps.blob.delete(job.blobPaths) : Promise.resolve(),
    ...job.providerIds.map((id) => deps.provider.delete(id)),
  ]);
  return results.every((result) => result.status === "fulfilled");
}

async function locked<T>(
  deps: TranscriptionDependencies,
  userId: string,
  id: string,
  action: () => Promise<T>,
): Promise<T> {
  const token = await deps.repository.acquire(userId, id);
  if (!token)
    throw new ApiError(
      409,
      "Esta gravação já está sendo atualizada. Aguarde alguns segundos.",
      3,
    );
  try {
    return await action();
  } finally {
    await deps.repository.release(userId, id, token);
  }
}

export async function grantUpload(
  deps: TranscriptionDependencies,
  userId: string,
  pathname: string,
  clientPayload: string | null,
) {
  if (!deps.configured)
    throw new ApiError(
      503,
      "A transcrição automática ainda não foi configurada.",
    );
  await deps.quota(userId, "poll");
  let payload: unknown;
  try {
    payload = JSON.parse(clientPayload ?? "null");
  } catch {
    throw new ApiError(400, "Dados de envio inválidos.");
  }
  const id = recordingId(
    (payload as { recordingId?: unknown } | null)?.recordingId,
  );
  const prefix = `transcriptions/${userId}/${id}/`;
  if (
    !pathname.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{16,80}\.(?:mp4|webm|m4a|wav|mp3)$/.test(
      pathname.slice(prefix.length),
    )
  ) {
    throw new ApiError(403, "Este envio não pertence à sua gravação.");
  }
  return locked(deps, userId, id, async () => {
    const previous = await deps.repository.get(userId, id);
    if (
      previous &&
      ["submitting", "queued", "processing", "completed"].includes(
        previous.status,
      ) &&
      previous.expiresAt > deps.now()
    ) {
      throw new ApiError(
        409,
        "Esta gravação já tem uma transcrição em andamento ou pronta.",
      );
    }
    const reuse =
      previous?.status === "uploading" &&
      previous.pathname === pathname &&
      previous.expiresAt > deps.now();
    if (!reuse) await deps.quota(userId, "upload");
    const now = deps.now();
    const paths = [...new Set([...(previous?.blobPaths ?? []), pathname])];
    if (paths.length > 50)
      throw new ApiError(
        429,
        "Há muitos envios pendentes para esta gravação. Tente novamente amanhã.",
        86400,
      );
    await deps.repository.save({
      userId,
      recordingId: id,
      status: "uploading",
      pathname,
      blobPaths: paths,
      providerIds: previous?.providerIds ?? [],
      createdAt: now,
      updatedAt: now,
      expiresAt: now + JOB_LIFETIME_MS,
    });
    return {
      allowedContentTypes: ALLOWED_CONTENT_TYPES,
      maximumSizeInBytes: MAX_UPLOAD_BYTES,
      validUntil: now + 15 * 60 * 1000,
      addRandomSuffix: false,
      allowOverwrite: false,
    };
  });
}

export async function handleTranscriptions(
  request: Request,
  deps: TranscriptionDependencies,
): Promise<Response> {
  try {
    if (!["GET", "POST", "DELETE"].includes(request.method))
      return json({ error: "Método não permitido." }, 405);
    const { userId } = await deps.authenticate(request);
    if (!deps.configured) {
      if (request.method === "GET")
        return json({
          configured: false,
          status: "idle",
          maxUploadBytes: MAX_UPLOAD_BYTES,
          maxAudioSeconds: MAX_AUDIO_MS / 1000,
        });
      throw new ApiError(
        503,
        "A transcrição automática ainda não foi configurada.",
      );
    }
    // Limit API traffic as well as new paid jobs. Idempotent retries do not
    // consume the daily submit allowance, but remain bounded per minute.
    await deps.quota(userId, request.method === "DELETE" ? "delete" : "poll");
    if (request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new ApiError(415, "Envie os dados em JSON.");
      const text = await request.text();
      if (text.length > 16_384)
        throw new ApiError(413, "Os dados da solicitação são grandes demais.");
      let body: { recordingId?: unknown; blobUrl?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError(400, "Dados da solicitação inválidos.");
      }
      const id = recordingId(body?.recordingId);
      return await locked(deps, userId, id, async () => {
        const job = await deps.repository.get(userId, id);
        if (!job || job.status === "deleted" || job.expiresAt <= deps.now())
          throw new ApiError(
            400,
            "Envie a gravação antes de solicitar a transcrição.",
          );
        if (job.status !== "uploading" && job.status !== "error")
          return json(jobResponse(job), job.status === "completed" ? 200 : 202);
        if (typeof body.blobUrl !== "string" || body.blobUrl.length > 2048)
          throw new ApiError(400, "Endereço do arquivo inválido.");
        // Lookup only the server-granted pathname, never fetch an arbitrary client URL.
        const blob = await deps.blob.head(job.pathname);
        let provided: URL, actual: URL;
        try {
          provided = new URL(body.blobUrl);
          actual = new URL(blob.url);
        } catch {
          throw new ApiError(400, "Endereço do arquivo inválido.");
        }
        if (
          provided.href !== actual.href ||
          actual.protocol !== "https:" ||
          !/^[a-z0-9]+\.private\.blob\.vercel-storage\.com$/i.test(
            actual.hostname,
          ) ||
          blob.pathname !== job.pathname
        ) {
          throw new ApiError(
            403,
            "O arquivo enviado não pertence a esta gravação.",
          );
        }
        if (
          !Number.isFinite(blob.size) ||
          blob.size <= 0 ||
          blob.size > MAX_UPLOAD_BYTES
        )
          throw new ApiError(413, "O arquivo deve ter até 512 MB.");
        if (
          !ALLOWED_CONTENT_TYPES.includes(blob.contentType.split(";")[0].trim())
        )
          throw new ApiError(415, "Formato de áudio ou vídeo não compatível.");
        await deps.quota(userId, "submit");
        const signedUrl = await deps.blob.signedGet(job.pathname);
        const submitting = {
          ...job,
          status: "submitting" as const,
          updatedAt: deps.now(),
          error: undefined,
        };
        await deps.repository.save(submitting);
        try {
          const remote = await deps.provider.submit(signedUrl);
          if (!remote.id || !/^[A-Za-z0-9_-]{1,128}$/.test(remote.id))
            throw new Error("Invalid provider job");
          const next: TranscriptionJob = {
            ...submitting,
            providerId: remote.id,
            providerIds: [...new Set([...job.providerIds, remote.id])],
            status: remote.status === "processing" ? "processing" : "queued",
            updatedAt: deps.now(),
          };
          await deps.repository.save(next);
          return json(jobResponse(next), 202);
        } catch {
          // No automatic POST retry: a timeout can mean the provider accepted it.
          await deps.repository.save({
            ...submitting,
            status: "error",
            error:
              "Não foi possível confirmar o pedido de transcrição. Tente novamente em alguns instantes.",
            updatedAt: deps.now(),
          });
          throw new ApiError(
            502,
            "Não foi possível confirmar o pedido de transcrição. Tente novamente em alguns instantes.",
          );
        }
      });
    }
    const id = recordingId(
      new URL(request.url).searchParams.get("recordingId"),
    );
    return await locked(deps, userId, id, async () => {
      const job = await deps.repository.get(userId, id);
      if (!job) return json(jobResponse(null));
      if (request.method === "DELETE") {
        const tombstone: TranscriptionJob = {
          ...job,
          status: "deleted",
          transcript: undefined,
          noSpeech: undefined,
          error: undefined,
          updatedAt: deps.now(),
        };
        await deps.repository.save(tombstone);
        const removed = await cleanupSources(tombstone, deps);
        return json({ ...jobResponse(null), cleanupPending: !removed });
      }
      if (job.expiresAt <= deps.now()) {
        await cleanupSources(job, deps);
        await deps.repository.save({
          ...job,
          status: "deleted",
          transcript: undefined,
          error: undefined,
          updatedAt: deps.now(),
        });
        return json(jobResponse(null));
      }
      if (
        job.status === "deleted" ||
        job.status === "completed" ||
        job.status === "error" ||
        job.status === "uploading"
      )
        return json(jobResponse(job));
      if (!job.providerId) return json(jobResponse(job), 202);
      const remote = await deps.provider.get(job.providerId);
      if (
        !["queued", "processing", "completed", "error"].includes(remote.status)
      )
        throw new ApiError(
          502,
          "O serviço retornou um estado de transcrição inválido.",
        );
      let next: TranscriptionJob = {
        ...job,
        status: remote.status,
        updatedAt: deps.now(),
      };
      if (remote.status === "completed") {
        try {
          next = { ...next, ...normalizeTranscript(remote, deps.now()) };
        } catch {
          next = {
            ...next,
            status: "error",
            error:
              "A transcrição retornou tempos inválidos. Verifique o áudio e tente novamente.",
          };
        }
      }
      if (remote.status === "error")
        next.error =
          "Não foi possível transcrever esta gravação. Verifique o áudio e tente novamente.";
      await deps.repository.save(next);
      if (next.status === "completed" || next.status === "error")
        await cleanupSources(next, deps);
      return json(jobResponse(next));
    });
  } catch (error) {
    return errorResponse(error);
  }
}
