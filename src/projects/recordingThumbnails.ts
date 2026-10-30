export interface RecordingThumbnailData {
  /** Small JPEG data URL; video bytes remain in the recording store. */
  thumbnail: string;
  thumbnailAtSeconds: number;
}

const abortError = () => new DOMException('A prévia foi cancelada.', 'AbortError');

/** Decode the actual saved video at 5%, falling back to its first decoded frame. */
export async function createRecordingThumbnail(
  blob: Blob,
  durationMs = 0,
  signal?: AbortSignal,
): Promise<RecordingThumbnailData> {
  if (signal?.aborted) throw abortError();
  if (!blob.size) throw new Error('Este vídeo está vazio.');
  const video = document.createElement('video');
  const url = URL.createObjectURL(blob);
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;

  const waitFor = (eventName: 'loadeddata' | 'seeked', milliseconds: number) => new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(eventName, done);
      video.removeEventListener('error', failed);
      signal?.removeEventListener('abort', aborted);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Não foi possível abrir a prévia deste vídeo.')); };
    const aborted = () => { cleanup(); reject(abortError()); };
    const timer = setTimeout(failed, milliseconds);
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener('error', failed, { once: true });
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });

  const capture = (): RecordingThumbnailData => {
    if (!video.videoWidth || !video.videoHeight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)
      throw new Error('A prévia ainda não está pronta.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(320 / video.videoWidth, 180 / video.videoHeight, 1);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Não foi possível criar a prévia deste vídeo.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    let thumbnail = canvas.toDataURL('image/jpeg', 0.7);
    if (thumbnail.length > 48_000) thumbnail = canvas.toDataURL('image/jpeg', 0.4);
    if (!thumbnail.startsWith('data:image/jpeg;base64,') || thumbnail.length > 64_000)
      throw new Error('Não foi possível salvar a prévia deste vídeo.');
    return { thumbnail, thumbnailAtSeconds: video.currentTime };
  };

  try {
    const loaded = waitFor('loadeddata', 8000);
    video.src = url;
    video.load();
    await loaded;
    const firstFrame = capture();
    const duration = Number.isFinite(video.duration) && video.duration > 0
      ? video.duration : Number.isFinite(durationMs) ? Math.max(0, durationMs / 1000) : 0;
    const target = duration * 0.05;
    if (target < 0.001) return firstFrame;
    try {
      const sought = waitFor('seeked', 3000);
      video.currentTime = target;
      await sought;
      return capture();
    } catch (error) {
      if (signal?.aborted) throw error;
      return firstFrame;
    }
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
