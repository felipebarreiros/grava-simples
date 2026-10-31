export type CreatorEvent =
  | 'project_created' | 'signup_viewed' | 'account_authenticated' | 'studio_opened'
  | 'capture_requested' | 'capture_ready' | 'capture_failed'
  | 'recording_started' | 'recording_completed' | 'recording_failed'
  | 'recording_saved' | 'recording_save_failed' | 'recording_opened'
  | 'export_started' | 'export_prepared' | 'export_failed' | 'download_requested'
  | 'video_downloaded' | 'transcription_requested' | 'transcript_downloaded' | 'transcript_corrected';

export type EventProperties = {
  orientation?: string; format?: string; source_kind?: string; resolution?: string;
  target_fps?: number; microphone_enabled?: boolean; duration_ms?: number;
  recording_duration_ms?: number; measured_capture_fps?: number;
  landscape_frames?: number; portrait_frames?: number;
  landscape_bytes?: number; portrait_bytes?: number;
  file_bytes?: number; audio_enabled?: boolean; capture_below_target?: boolean;
  error_code?: string; stage?: string; outcome?: string; download_kind?: string;
};

/** Only operational categories/counters enter creator events or their logs. */
export function creatorProperties(properties: EventProperties): EventProperties {
  const clean: Record<string, string | number | boolean> = {};
  for (const key of ['orientation', 'format', 'source_kind', 'resolution', 'error_code', 'stage', 'outcome', 'download_kind'] as const) {
    const value = properties[key];
    if (typeof value === 'string' && /^[a-z0-9_.+-]{1,48}$/.test(value)) clean[key] = value;
  }
  for (const key of ['microphone_enabled', 'audio_enabled', 'capture_below_target'] as const)
    if (typeof properties[key] === 'boolean') clean[key] = properties[key];
  for (const [key, maximum] of Object.entries({
    duration_ms: 86_400_000, recording_duration_ms: 86_400_000,
    measured_capture_fps: 240, target_fps: 240,
    landscape_frames: 100_000_000, portrait_frames: 100_000_000,
    landscape_bytes: 1_099_511_627_776, portrait_bytes: 1_099_511_627_776,
    file_bytes: 1_099_511_627_776,
  })) {
    const value = properties[key as keyof EventProperties];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      clean[key] = Math.min(maximum, Math.round(value * 100) / 100);
  }
  return clean;
}
