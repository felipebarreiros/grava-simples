export interface LayoutInput {
  outputWidth: number;
  outputHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  cameraWidth: number;
  cameraHeight: number;
  mode: 'camera' | 'screen-camera';
  orientation: 'landscape' | 'portrait';
}
export interface ObsRect {
  x: number; y: number; width: number; height: number;
  cropX: number; cropY: number; cropWidth: number; cropHeight: number;
}
export interface ObsEngine {
  backend: 'obs-wasm-subset';
  capabilities: {
    backend: 'obs-wasm-subset'; label: string; libobsRuntime: false;
    obsVersion: string; obsCommit: string; compiler: string;
    sceneGeometry: string; audioProcessing: string;
    browserReplacements: string[]; notPorted: string[];
    license: string; sourceArchive: string; licenseUrl: string; wasmSha256: string;
  };
  stats: { layoutCalls: number; audioNodes: number; audioBlocks: number };
  layout(input: LayoutInput): { source: ObsRect; camera?: ObsRect };
  computeLayout(input: LayoutInput): { source: ObsRect; camera?: ObsRect };
  audioGainDb(decibels: number): number;
  createCompressorNode(context: AudioContext): Promise<AudioWorkletNode>;
}
export function loadObsEngine(): Promise<ObsEngine>;
export default loadObsEngine;
