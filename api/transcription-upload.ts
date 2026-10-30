import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createRuntime } from "../server/transcription/runtime.ts";
import { errorResponse } from "../server/transcription/service.ts";
import { handleTranscriptionUpload } from "../server/transcription/upload.ts";
import { webRequest, writeResponse } from "../server/transcription/http.ts";

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  try {
    await writeResponse(
      await handleTranscriptionUpload(
        webRequest(request),
        createRuntime(),
        process.env.BLOB_READ_WRITE_TOKEN,
      ),
      response,
    );
  } catch (error) {
    await writeResponse(errorResponse(error), response);
  }
}
