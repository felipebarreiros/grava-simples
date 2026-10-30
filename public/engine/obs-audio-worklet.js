/* GPL-2.0-or-later. Host of actual OBS compressor DSP compiled to Wasm.
 * Browser adapter created 2026-10-30. Native sidechain is not implemented. */
class ObsCompressor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.wasm = new WebAssembly.Instance(options.processorOptions.module, {}).exports;
    this.wasm._initialize?.();
    this.pointer = this.wasm.obs_audio_buffer(0);
    this.samples = new Float32Array(this.wasm.memory.buffer, this.pointer, 4096);
    this.channels = 0;
    this.blocks = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    if (!input?.length || !output?.length) return true;
    const channels = Math.min(input.length, 2), frames = input[0].length;
    if (frames < 1 || frames > 2048) return false;
    if (this.channels !== channels) {
      this.wasm.obs_compressor_config(0, sampleRate, channels, 4, -18, 6, 100, 0);
      this.channels = channels;
    }
    for (let c = 0; c < channels; c++) this.samples.set(input[c], c * 2048);
    this.wasm.obs_compressor_process(0, frames);
    for (let c = 0; c < output.length; c++) {
      const sourceChannel = Math.min(c, channels - 1);
      output[c].set(this.samples.subarray(sourceChannel * 2048, sourceChannel * 2048 + frames));
    }
    this.blocks++;
    if (this.blocks % 128 === 0) this.port.postMessage({ type: 'stats', audioBlocks: this.blocks });
    return true;
  }
}
registerProcessor('obs-compressor', ObsCompressor);
