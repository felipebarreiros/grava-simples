import type { RecordingFile, StudioConfig, StudioEvent } from '../media/types';

const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 1024 ** 4;

export type RecordingFailureCode =
  | 'permission_denied' | 'device_not_found' | 'device_unavailable'
  | 'constraints_unsupported' | 'unsupported_browser' | 'storage_full'
  | 'invalid_state' | 'aborted' | 'timeout' | 'unknown';

/** Categorize browser errors without exporting messages, paths or device names. */
export function recordingFailureCode(error: unknown): RecordingFailureCode {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object' && !seen.has(current); depth++) {
    seen.add(current);
    let name: unknown, cause: unknown;
    try { name = (current as Error).name; cause = (current as Error).cause; } catch { return 'unknown'; }
    switch (name) {
      case 'NotAllowedError': case 'PermissionDeniedError': case 'SecurityError': return 'permission_denied';
      case 'NotFoundError': case 'DevicesNotFoundError': return 'device_not_found';
      case 'NotReadableError': case 'TrackStartError': return 'device_unavailable';
      case 'OverconstrainedError': case 'ConstraintNotSatisfiedError': return 'constraints_unsupported';
      case 'NotSupportedError': return 'unsupported_browser';
      case 'QuotaExceededError': return 'storage_full';
      case 'InvalidStateError': return 'invalid_state';
      case 'AbortError': return 'aborted';
      case 'TimeoutError': return 'timeout';
    }
    current = cause;
  }
  return 'unknown';
}

function number(value: unknown, max: number, decimals = 0): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return undefined;
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

export function elapsedRecordingOperation(started: number, now = performance.now()): number {
  return number(now - started, MAX_DURATION_MS) ?? 0;
}

/** Deliberately reconstruct fields instead of passing a capture config to PostHog. */
export function recordingSettings(config?: Partial<StudioConfig>) {
  return {
    ...(['camera', 'screen', 'media', 'test'].includes(config?.source ?? '') ? { source_kind: config!.source } : {}),
    ...(['360', '720', '1080', '4k', 'test'].includes(config?.resolution ?? '') ? { resolution: config!.resolution } : {}),
    ...([30, 60].includes(config?.fps ?? 0) ? { target_fps: config!.fps } : {}),
    ...(typeof config?.microphone === 'boolean' ? { microphone_enabled: config.microphone } : {}),
  };
}

export function recordingFileProperties(file: Pick<RecordingFile, 'orientation' | 'mimeType' | 'size' | 'durationMs'>) {
  return {
    orientation: file.orientation,
    format: file.mimeType.startsWith('video/mp4') ? 'mp4' : file.mimeType.startsWith('video/webm') ? 'webm' : 'unknown',
    recording_duration_ms: number(file.durationMs, MAX_DURATION_MS),
    file_bytes: number(file.size, MAX_FILE_BYTES),
  };
}

/** Capture cadence is rendered canvas cadence, not independently decoded video FPS. */
export function recordingSummary(event: Pick<StudioEvent, 'config' | 'metrics' | 'result'>) {
  const duration = number(event.result?.landscape.durationMs ?? event.metrics.elapsedMs, MAX_DURATION_MS);
  const landscapeFrames = number(event.metrics.frames.landscape, 100_000_000);
  const measured = duration && landscapeFrames !== undefined
    ? number(landscapeFrames * 1000 / duration, 240, 2) : undefined;
  return {
    ...recordingSettings(event.config),
    recording_duration_ms: duration,
    measured_capture_fps: measured,
    landscape_frames: landscapeFrames,
    portrait_frames: number(event.metrics.frames.portrait, 100_000_000),
    landscape_bytes: number(event.result?.landscape.size ?? event.metrics.bytes.landscape, MAX_FILE_BYTES),
    portrait_bytes: number(event.result?.portrait.size ?? event.metrics.bytes.portrait, MAX_FILE_BYTES),
    ...(duration !== undefined && duration >= 2000 && measured !== undefined && event.config?.fps
      ? { capture_below_target: measured < event.config.fps * 0.8 } : {}),
    audio_enabled: Boolean(event.metrics.audio),
  };
}
