class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._buffer = [];
    this._targetRate = (options.processorOptions && options.processorOptions.targetSampleRate) || 16000;
    // Downsampling ratio: e.g. 48000/16000 = 3
    this._step = Math.round(sampleRate / this._targetRate);
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;

    // Downsample and convert Float32 → Int16
    for (let i = 0; i < input.length; i += this._step) {
      this._buffer.push(Math.max(-1, Math.min(1, input[i])) * 0x7fff);
    }

    if (this._buffer.length >= 4096) {
      const pcm = new Int16Array(this._buffer.splice(0, 4096));
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
