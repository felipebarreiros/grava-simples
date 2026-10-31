import { del, head, issueSignedToken, presignUrl } from "@vercel/blob";
import { ApiError, authenticate } from "./security.ts";
import { postgresQuota, postgresRepository } from "./postgres.ts";
import {
  MAX_AUDIO_MS,
  type JobRepository,
  type ProviderTranscript,
  type TranscriptionDependencies,
} from "./types.ts";

function configured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.ASSEMBLYAI_API_KEY &&
      env.BLOB_READ_WRITE_TOKEN &&
      env.DATABASE_URL,
  );
}
const unavailableRepository: JobRepository = {
  get: async () => {
    throw new ApiError(
      503,
      "O armazenamento de transcrições não está configurado.",
    );
  },
  save: async () => {
    throw new ApiError(
      503,
      "O armazenamento de transcrições não está configurado.",
    );
  },
  acquire: async () => {
    throw new ApiError(
      503,
      "O armazenamento de transcrições não está configurado.",
    );
  },
  release: async () => {},
  due: async () => [],
  remove: async () => {},
};

export function createRuntime(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptionDependencies {
  const ready = configured(env);
  const model = env.ASSEMBLYAI_SPEECH_MODEL || "universal-2";
  if (ready && !["universal-2", "universal-3-5-pro"].includes(model))
    throw new ApiError(
      503,
      "O modelo de transcrição não está configurado corretamente.",
    );
  async function providerRequest(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<ProviderTranscript> {
    const response = await fetch(
      `https://api.assemblyai.com/v2/transcript${path}`,
      {
        method,
        headers: {
          authorization: env.ASSEMBLYAI_API_KEY!,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (method === "DELETE" && response.status === 404)
      return { id: path.slice(1), status: "error" };
    if (!response.ok)
      throw new ApiError(
        response.status === 429 ? 429 : 502,
        response.status === 429
          ? "O serviço de transcrição está ocupado. Tente novamente em instantes."
          : "O serviço de transcrição está indisponível. Tente novamente.",
        response.status === 429 ? 30 : undefined,
      );
    if (method === "DELETE") return { id: path.slice(1), status: "error" };
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > 4_000_000)
      throw new ApiError(502, "A transcrição excedeu o limite desta versão.");
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 4_000_000)
      throw new ApiError(502, "A transcrição excedeu o limite desta versão.");
    return JSON.parse(text) as ProviderTranscript;
  }
  return {
    configured: ready,
    authenticate: (request) => authenticate(request, env),
    quota: (userId, action) => postgresQuota(userId, action, env),
    repository: ready ? postgresRepository(env) : unavailableRepository,
    blob: {
      head: (pathname) =>
        head(pathname, {
          token: env.BLOB_READ_WRITE_TOKEN,
          abortSignal: AbortSignal.timeout(8000),
        }),
      async signedGet(pathname) {
        const validUntil = Date.now() + 60 * 60 * 1000;
        const token = await issueSignedToken({
          token: env.BLOB_READ_WRITE_TOKEN,
          pathname,
          operations: ["get"],
          validUntil,
          abortSignal: AbortSignal.timeout(8000),
        });
        return (
          await presignUrl(token, {
            pathname,
            access: "private",
            operation: "get",
            validUntil,
          })
        ).presignedUrl;
      },
      delete: (paths) =>
        del(paths, {
          token: env.BLOB_READ_WRITE_TOKEN,
          abortSignal: AbortSignal.timeout(5000),
        }),
    },
    provider: {
      submit: (audioUrl) =>
        providerRequest("", "POST", {
          audio_url: audioUrl,
          speech_models: [model],
          language_detection: true,
          punctuate: true,
          format_text: true,
          audio_end_at: MAX_AUDIO_MS,
        }),
      get: (id) => providerRequest(`/${encodeURIComponent(id)}`),
      delete: async (id) => {
        await providerRequest(`/${encodeURIComponent(id)}`, "DELETE");
      },
    },
    now: Date.now,
  };
}
