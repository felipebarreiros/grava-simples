import { timingSafeEqual } from "node:crypto";
import { ApiError } from "./security.ts";
import { cleanupSources, errorResponse } from "./service.ts";
import type { TranscriptionDependencies } from "./types.ts";

export async function handleCleanup(
  request: Request,
  deps: TranscriptionDependencies,
  secret?: string,
): Promise<Response> {
  try {
    const actual = Buffer.from(request.headers.get("authorization") || "");
    const expected = Buffer.from(`Bearer ${secret || ""}`);
    if (
      !secret ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      throw new ApiError(401, "Acesso não autorizado.");
    if (request.method !== "GET")
      throw new ApiError(405, "Método não permitido.");
    if (!deps.configured)
      throw new ApiError(
        503,
        "A transcrição automática ainda não foi configurada.",
      );
    const due = await deps.repository.due(deps.now(), 50);
    let processed = 0,
      failures = 0;
    const started = Date.now();
    for (const entry of due) {
      if (Date.now() - started > 35_000) break;
      const token = await deps.repository.acquire(
        entry.userId,
        entry.recordingId,
      );
      if (!token) {
        failures++;
        continue;
      }
      try {
        const job = await deps.repository.get(entry.userId, entry.recordingId);
        if (!job) {
          await deps.repository.remove(entry.userId, entry.recordingId);
          processed++;
          continue;
        }
        if (job.expiresAt > deps.now()) continue;
        if (await cleanupSources(job, deps)) {
          await deps.repository.remove(entry.userId, entry.recordingId);
          processed++;
        } else failures++;
      } catch {
        failures++;
      } finally {
        await deps.repository.release(entry.userId, entry.recordingId, token);
      }
    }
    return Response.json(
      { processed, failures, remainingBatch: due.length - processed },
      {
        status: failures ? 503 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
