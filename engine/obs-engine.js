/* GPL-2.0-or-later. Browser host for the explicitly scoped OBS Wasm subset. */
const WASM_URL = '/engine/obs-core.wasm';
const RETRY_DELAYS_MS = [150, 350];
let pending;

export function loadObsEngine() {
  return pending ??= initialize().catch(error => {
    // A temporary asset failure must not poison every later initialization.
    pending = undefined;
    throw error;
  });
}

class ObsEngineAssetError extends Error {
  constructor(message, { assetPath, status = null, retryable, cause }) {
    super(message, { cause });
    this.name = 'ObsEngineAssetError';
    this.assetPath = assetPath;
    this.status = status;
    this.retryable = retryable;
  }
}

async function readAsset(assetPath, label, read) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(assetPath, { cache: attempt ? 'reload' : 'default' });
      if (!response.ok) {
        const status = response.status;
        throw new ObsEngineAssetError(`${label} HTTP ${status} (${assetPath}).`, {
          assetPath,
          status,
          retryable: status === 404 || status === 408 || status === 429 || (status >= 500 && status < 600),
        });
      }
      return await read(response);
    } catch (cause) {
      const error = cause instanceof ObsEngineAssetError ? cause : new ObsEngineAssetError(
        `${label} ${response ? 'Resposta inválida' : 'Falha de rede'} (${assetPath}).`, {
          assetPath,
          status: response?.status,
          // Fetch and interrupted response bodies reject with TypeError. Do not
          // repeatedly parse an invalid manifest or retry a canceled request.
          retryable: cause?.name !== 'AbortError' && (!response || cause instanceof TypeError),
          cause,
        },
      );
      if (!error.retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function initialize() {
  const [binary, capabilities] = await Promise.all([
    readAsset(WASM_URL, 'OBS Wasm não pôde ser carregado.', response => response.arrayBuffer()),
    readAsset('/engine/capabilities.json', 'Manifesto OBS indisponível.', response => response.json()),
  ]);
  const module = await WebAssembly.compile(binary);
  const instance = await WebAssembly.instantiate(module, {});
  const wasm = instance.exports;
  wasm._initialize?.();
  const stats = { layoutCalls: 0, audioNodes: 0, audioBlocks: 0 };
  const readRect = a => ({ x: a[0], y: a[1], width: a[2], height: a[3],
    cropX: a[4], cropY: a[5], cropWidth: a[6], cropHeight: a[7] });
  const engine = {
    backend: capabilities.backend,
    capabilities,
    stats,
    layout(input) {
      const keys = ['outputWidth', 'outputHeight', 'sourceWidth', 'sourceHeight', 'cameraWidth', 'cameraHeight'];
      const values = keys.map(key => {
        const value = Number(input[key]);
        if (!Number.isFinite(value) || value <= 0 || value > 32768) throw new Error(`Dimensão inválida: ${key}`);
        return value;
      });
      const pointer = wasm.obs_layout(...values, input.mode === 'screen-camera' ? 1 : 0,
        input.orientation === 'portrait' ? 1 : 0);
      const a = new Float32Array(wasm.memory.buffer, pointer, 16);
      stats.layoutCalls++;
      return { source: readRect(a), ...(input.mode === 'screen-camera' ? { camera: readRect(a.subarray(8)) } : {}) };
    },
    audioGainDb(db) {
      if (!Number.isFinite(db)) throw new Error('Ganho de áudio inválido.');
      return wasm.obs_audio_gain_db(db);
    },
    async createCompressorNode(context) {
      await context.audioWorklet.addModule('/engine/obs-audio-worklet.js');
      const node = new AudioWorkletNode(context, 'obs-compressor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: { module },
      });
      node.port.onmessage = event => {
        if (event.data?.type === 'stats') stats.audioBlocks = event.data.audioBlocks;
      };
      stats.audioNodes++;
      return node;
    },
  };
  engine.computeLayout = engine.layout;
  return engine;
}

export default loadObsEngine;
