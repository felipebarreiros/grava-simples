import { randomUUID } from "node:crypto";
import { Redis } from "@upstash/redis";
import { del, head, issueSignedToken, presignUrl } from "@vercel/blob";
import { ApiError, authenticate, limitBucket } from "./security.ts";
import {
  MAX_AUDIO_MS,
  type JobRepository,
  type ProviderTranscript,
  type TranscriptionDependencies,
  type TranscriptionJob,
} from "./types.ts";

const PREFIX = "grava:transcription:v1";
const INDEX = `${PREFIX}:cleanup`;
const RECORD_TTL = 7 * 86400;
const releaseLockScript = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;
const member = (userId: string, recordingId: string) =>
  `${userId}:${recordingId}`;
const jobKey = (userId: string, recordingId: string) =>
  `${PREFIX}:job:${member(userId, recordingId)}`;
const lockKey = (userId: string, recordingId: string) =>
  `${PREFIX}:lock:${member(userId, recordingId)}`;

export function redisRepository(redis: Redis): JobRepository {
  return {
    get: (userId, recordingId) =>
      redis.get<TranscriptionJob>(jobKey(userId, recordingId)),
    async save(job) {
      // Index before data: an interrupted write can leave an empty index entry,
      // which cleanup safely removes; it cannot leave unindexed media metadata.
      await redis.zadd(INDEX, {
        score: job.expiresAt,
        member: member(job.userId, job.recordingId),
      });
      await redis.set(jobKey(job.userId, job.recordingId), job, {
        ex: RECORD_TTL,
      });
    },
    async acquire(userId, recordingId) {
      const token = randomUUID();
      const result = await redis.set(lockKey(userId, recordingId), token, {
        nx: true,
        ex: 45,
      });
      return result === "OK" ? token : null;
    },
    async release(userId, recordingId, token) {
      await redis.eval(
        releaseLockScript,
        [lockKey(userId, recordingId)],
        [token],
      );
    },
    async due(now, limit) {
      const entries = await redis.zrange<string[]>(INDEX, 0, now, {
        byScore: true,
        offset: 0,
        count: limit,
      });
      return entries
        .map((value) => {
          const [userId, recordingId] = value.split(":");
          return { userId, recordingId };
        })
        .filter(
          (value) =>
            /^user_[\w-]+$/.test(value.userId) &&
            /^[\w-]{1,128}$/.test(value.recordingId),
        );
    },
    async remove(userId, recordingId) {
      await redis.del(jobKey(userId, recordingId));
      await redis.zrem(INDEX, member(userId, recordingId));
    },
  };
}

function configured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.ASSEMBLYAI_API_KEY &&
      env.BLOB_READ_WRITE_TOKEN &&
      env.UPSTASH_REDIS_REST_URL &&
      env.UPSTASH_REDIS_REST_TOKEN,
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
  const redis = ready
    ? new Redis({
        url: env.UPSTASH_REDIS_REST_URL!,
        token: env.UPSTASH_REDIS_REST_TOKEN!,
        retry: false,
      })
    : undefined;
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
    async quota(userId, action) {
      if (!redis)
        throw new ApiError(
          503,
          "Os limites de transcrição não estão configurados.",
        );
      await limitBucket(
        redis,
        `${PREFIX}:quota:${action}:${userId}`,
        action === "poll" || action === "delete" ? 60 : 6,
        action === "poll" || action === "delete" ? 60 : 86400,
      );
    },
    repository: redis ? redisRepository(redis) : unavailableRepository,
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
