import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createRuntime } from "../server/transcription/runtime.ts";
import {
  errorResponse,
  handleTranscriptions,
} from "../server/transcription/service.ts";
import { webRequest, writeResponse } from "../server/transcription/http.ts";

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  try {
    await writeResponse(
      await handleTranscriptions(webRequest(request), createRuntime()),
      response,
    );
  } catch (error) {
    await writeResponse(errorResponse(error), response);
  }
}
