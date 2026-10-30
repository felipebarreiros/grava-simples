import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { RecordingFile } from './types';

export interface CompatibleExportProgress {
  phase: 'loading' | 'converting';
  /** Fraction from zero to one when FFmpeg can estimate it. */
  progress?: number;
}

const MAX_LOCAL_EXPORT_BYTES = 256 * 1024 * 1024;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Normalize a download to ordinary MP4/H.264 + AAC without uploading the video.
 * The optional worker is loaded only on demand, after capture has finished.
 * Original local recording files remain untouched if export fails.
 */
export function prepareCompatibleDownload(
  file: RecordingFile,
  onProgress?: (progress: CompatibleExportProgress) => void,
): Promise<RecordingFile> {
  const conversion = queue.then(() => convert(file, onProgress));
  queue = conversion.catch(() => undefined);
  return conversion;
}

async function convert(file: RecordingFile, onProgress?: (progress: CompatibleExportProgress) => void): Promise<RecordingFile> {
  if (!file.mimeType.startsWith('video/mp4')) throw new Error('Este navegador gravou em WebM. Para baixar em MP4 compatível, grave usando Chrome ou Safari com suporte a H.264. O arquivo original continua disponível.');
  if (file.blob.size > MAX_LOCAL_EXPORT_BYTES) throw new Error('Este vídeo é grande demais para a conversão local nesta versão (limite de 256 MB por arquivo). Baixe o original ou grave um trecho menor para compartilhar.');
  let ffmpeg: FFmpeg | undefined;
  try {
    onProgress?.({ phase: 'loading' });
    const { FFmpeg } = await import('@ffmpeg/ffmpeg');
    ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => onProgress?.({ phase: 'converting', progress: Math.max(0, Math.min(1, progress)) }));
    await ffmpeg.load({
      coreURL: new URL('/export/ffmpeg-core.js', window.location.origin).href,
      wasmURL: new URL('/export/ffmpeg-core.wasm', window.location.origin).href,
    });
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await file.blob.arrayBuffer()));
    onProgress?.({ phase: 'converting', progress: 0 });
    const exitCode = await ffmpeg.exec([
      '-i', 'input.mp4', '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '48000',
      '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', 'output.mp4',
    ], 300_000);
    if (exitCode !== 0) throw new Error('Não foi possível preparar este vídeo para compartilhamento. O arquivo original continua disponível.');
    const output = await ffmpeg.readFile('output.mp4');
    if (!(output instanceof Uint8Array) || !output.byteLength) throw new Error('A conversão não gerou um vídeo. O arquivo original continua disponível.');
    const mimeType = 'video/mp4;codecs=avc1,mp4a.40.2';
    const bytes = new Uint8Array(output.byteLength);
    bytes.set(output);
    const blob = new Blob([bytes], { type: mimeType });
    onProgress?.({ phase: 'converting', progress: 1 });
    return { ...file, blob, mimeType, size: blob.size, url: URL.createObjectURL(blob), fileName: file.fileName.replace(/\.[^.]+$/, '') + '-compartilhar.mp4' };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error('Não foi possível preparar o download. Tente novamente ou baixe o arquivo original.');
  } finally {
    // Release the worker's input/output buffers rather than holding a second
    // copy of an entire take after the download. Browser caching keeps assets.
    ffmpeg?.terminate();
  }
}
