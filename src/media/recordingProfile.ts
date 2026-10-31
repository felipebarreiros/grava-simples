import type { Resolution } from './types.ts';

export const RECORDING_AUDIO_BITS_PER_SECOND = 192_000;

/** Pick a target rate that preserves detail in camera and text-heavy screen captures. */
export function recordingVideoBitrate(config: { resolution: Resolution; fps: 30 | 60 }): number {
  const base = config.resolution === '4k' ? 45_000_000 : config.resolution === '1080' ? 16_000_000 : config.resolution === '720' ? 8_000_000 : 2_500_000;
  return base * (config.fps === 60 ? 1.5 : 1);
}
