import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { webRequest, writeResponse } from "../server/transcription/http.ts";
import { createStorageRuntime } from "../server/storage/runtime.ts";
import { grantRecordingUpload, storageError } from "../server/storage/service.ts";
import { ApiError } from "../server/transcription/security.ts";
import { observeServerRequest } from "../server/analytics.ts";
export default async function handler(incoming: VercelRequest, response: VercelResponse) {
  try {
    const request = webRequest(incoming), deps = createStorageRuntime();
    const result = await observeServerRequest("recordings-upload", request, async telemetry => {
      try {
        if (request.method !== "POST") throw new ApiError(405, "Método não permitido.");
        const { userId } = await deps.authenticate(request);
        telemetry.identify(userId);
        if (!deps.configured) throw new ApiError(503, "O armazenamento na nuvem ainda não foi configurado.");
        await deps.quota(userId, "request");
        const text = await request.text();
        if (text.length > 16_384) throw new ApiError(413, "Os dados do envio são grandes demais.");
        let body: HandleUploadBody;
        try { body = JSON.parse(text); } catch { throw new ApiError(400, "Dados de envio inválidos."); }
        // Completion requires explicit authenticated finalization and HEAD verification.
        if (body?.type !== "blob.generate-client-token") throw new ApiError(400, "Tipo de envio inválido.");
        const uploaded = await handleUpload({ request, body, token: process.env.RECORDINGS_BLOB_READ_WRITE_TOKEN, onBeforeGenerateToken: (pathname, payload) => grantRecordingUpload(deps, userId, pathname, payload) });
        return Response.json(uploaded, { headers: { "Cache-Control": "private, no-store", Vary: "Authorization" } });
      } catch (error) { return storageError(error); }
    });
    await writeResponse(result, response);
  } catch (error) { await writeResponse(storageError(error), response); }
}
