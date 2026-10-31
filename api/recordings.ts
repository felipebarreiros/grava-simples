import type { VercelRequest, VercelResponse } from "@vercel/node";
import { observeServerRequest } from "../server/analytics.ts";
import { webRequest, writeResponse } from "../server/transcription/http.ts";
import { createStorageRuntime } from "../server/storage/runtime.ts";
import { handleRecordings, storageError } from "../server/storage/service.ts";
export default async function handler(request: VercelRequest, response: VercelResponse) {
  try {
    const incoming = webRequest(request), deps = createStorageRuntime();
    const result = await observeServerRequest("recordings", incoming, telemetry => handleRecordings(incoming, {
      ...deps,
      authenticate: async request => { const identity = await deps.authenticate(request); telemetry.identify(identity.userId); return identity; },
    }));
    await writeResponse(result, response);
  }
  catch (error) { await writeResponse(storageError(error), response); }
}
