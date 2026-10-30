import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { ApiError } from "./security.ts";
import { errorResponse, grantUpload } from "./service.ts";
import type { TranscriptionDependencies } from "./types.ts";

export async function handleTranscriptionUpload(
  request: Request,
  deps: TranscriptionDependencies,
  token?: string,
): Promise<Response> {
  try {
    if (request.method !== "POST")
      throw new ApiError(405, "Método não permitido.");
    const { userId } = await deps.authenticate(request);
    if (!deps.configured)
      throw new ApiError(
        503,
        "A transcrição automática ainda não foi configurada.",
      );
    const text = await request.text();
    if (text.length > 16_384)
      throw new ApiError(413, "Os dados do envio são grandes demais.");
    let body: HandleUploadBody;
    try {
      body = JSON.parse(text) as HandleUploadBody;
    } catch {
      throw new ApiError(400, "Dados de envio inválidos.");
    }
    // No completion callback is issued: submit verifies the stored object with
    // head(). This endpoint accepts only authenticated user token requests.
    if (body?.type !== "blob.generate-client-token")
      throw new ApiError(400, "Tipo de envio inválido.");
    const result = await handleUpload({
      body,
      request,
      token,
      onBeforeGenerateToken: (pathname, clientPayload) =>
        grantUpload(deps, userId, pathname, clientPayload),
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store", Vary: "Authorization" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
