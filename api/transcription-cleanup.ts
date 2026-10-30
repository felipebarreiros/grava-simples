import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createRuntime } from "../server/transcription/runtime.ts";
import { errorResponse } from "../server/transcription/service.ts";
import { handleCleanup } from "../server/transcription/cleanup.ts";
import { webRequest, writeResponse } from "../server/transcription/http.ts";

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  try {
    await writeResponse(
      await handleCleanup(
        webRequest(request),
        createRuntime(),
        process.env.CRON_SECRET,
      ),
      response,
    );
  } catch (error) {
    await writeResponse(errorResponse(error), response);
  }
}
