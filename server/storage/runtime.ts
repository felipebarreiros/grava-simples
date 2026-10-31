import { del, head, issueSignedToken, presignUrl } from "@vercel/blob";
import { consumeQuota } from "../transcription/postgres.ts";
import { authenticate } from "../transcription/security.ts";
import { postgresRecordings } from "./repository.ts";
import { withMaintenance } from "./database.ts";
import type { StorageDependencies } from "./types.ts";

export function createStorageRuntime(env: NodeJS.ProcessEnv = process.env): StorageDependencies {
  return {
    configured: Boolean(env.DATABASE_URL && env.RECORDINGS_BLOB_READ_WRITE_TOKEN),
    authenticate: request => authenticate(request, env),
    repository: postgresRecordings(env),
    quota: (userId, action) => consumeQuota(userId, action === "request" ? "storage_request" : action === "reserve" ? "storage_reserve" : "storage_upload", action === "request" ? 120 : action === "reserve" ? 30 : 60, action === "request" ? 60 : 3600, env),
    blob: {
      head: pathname => head(pathname, { token: env.RECORDINGS_BLOB_READ_WRITE_TOKEN, abortSignal: AbortSignal.timeout(8000) }),
      async signedGet(pathname) {
        const expiresAt = Date.now() + 10 * 60 * 1000;
        const token = await issueSignedToken({ token: env.RECORDINGS_BLOB_READ_WRITE_TOKEN, pathname, operations: ["get"], validUntil: expiresAt, abortSignal: AbortSignal.timeout(8000) });
        const signed = await presignUrl(token, { access: "private", operation: "get", pathname, validUntil: expiresAt });
        return { url: signed.presignedUrl, expiresAt };
      },
      delete: paths => del(paths, { token: env.RECORDINGS_BLOB_READ_WRITE_TOKEN, abortSignal: AbortSignal.timeout(8000) }),
    },
    now: Date.now,
  };
}

/** Called only after the shared cron handler verifies CRON_SECRET. Bounded and retryable. */
export async function cleanupRecordings(env: NodeJS.ProcessEnv = process.env): Promise<{ removed: number; failed: number }> {
  if (!env.GRAVA_MAINTENANCE_URL || !env.RECORDINGS_BLOB_READ_WRITE_TOKEN) return { removed: 0, failed: 0 };
  const runtime = createStorageRuntime(env);
  const candidates = await withMaintenance(async client => client.query<{ recording_id: string; pathnames: string[] }>("SELECT * FROM grava_storage.recording_cleanup_candidates(25)"), env);
  let removed = 0, failed = 0;
  const deadline = Date.now() + 12_000;
  for (const candidate of candidates.rows) {
    if (Date.now() > deadline) break;
    try {
      if (candidate.pathnames.length) await runtime.blob.delete(candidate.pathnames);
      await withMaintenance(client => client.query("SELECT grava_storage.finish_recording_cleanup($1)", [candidate.recording_id]), env);
      removed++;
    } catch { failed++; }
  }
  return { removed, failed };
}
