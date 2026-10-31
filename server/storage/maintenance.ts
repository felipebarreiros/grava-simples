import { timingSafeEqual } from 'node:crypto';
import { observeServerRequest } from '../analytics.ts';
import { handleCleanup } from '../transcription/cleanup.ts';
import { ApiError } from '../transcription/security.ts';
import { errorResponse } from '../transcription/service.ts';
import type { TranscriptionDependencies } from '../transcription/types.ts';

export function handleStorageMaintenance(request: Request, transcription: TranscriptionDependencies, cleanup: () => Promise<{ removed: number; failed: number }>, secret?: string): Promise<Response> {
  return observeServerRequest('transcription-cleanup', request, async () => {
    try {
      const actual = Buffer.from(request.headers.get('authorization') || '');
      const expected = Buffer.from(`Bearer ${secret || ''}`);
      if (!secret || actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new ApiError(401, 'Acesso não autorizado.');
      if (request.method !== 'GET') throw new ApiError(405, 'Método não permitido.');
      // Cleanup uses independent bounded paths and separate Blob credentials.
      // Both start only after cron authentication; customer sessions cannot run it.
      const [transcripts, recordings] = await Promise.allSettled([
        transcription.configured
          ? handleCleanup(request, transcription, secret, false).then(async result => ({ status: result.status, body: await result.json() }))
          : Promise.resolve({ status: 200, body: { configured: false } }),
        cleanup(),
      ]);
      const failed = transcripts.status === 'rejected' || recordings.status === 'rejected' ||
        (transcripts.status === 'fulfilled' && transcripts.value.status >= 400) ||
        (recordings.status === 'fulfilled' && recordings.value.failed > 0);
      return Response.json({
        transcription: transcripts.status === 'fulfilled' ? transcripts.value.body : { failed: true },
        recordings: recordings.status === 'fulfilled' ? recordings.value : { failed: true },
      }, { status: failed ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return errorResponse(error); }
  });
}
