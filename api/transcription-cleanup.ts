import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createRuntime } from "../server/transcription/runtime.ts";
import { errorResponse } from "../server/transcription/service.ts";
import { webRequest, writeResponse } from "../server/transcription/http.ts";
import { cleanupRecordings } from "../server/storage/runtime.ts";
import { handleStorageMaintenance } from "../server/storage/maintenance.ts";

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  try {
    await writeResponse(
      await handleStorageMaintenance(webRequest(request), createRuntime(), () => cleanupRecordings(), process.env.CRON_SECRET),
      response,
    );
  } catch (error) {
    await writeResponse(errorResponse(error), response);
  }
}
