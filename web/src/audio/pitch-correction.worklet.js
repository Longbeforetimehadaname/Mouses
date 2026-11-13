/**
 * One granular pitch shifter for the mixed stem bus.
 * Two overlapping Hann grains read a delay line at 2^(semitones/12)
 * so a playbackRate change can be pitch-compensated without
 * SharedArrayBuffer or cross-origin isolation.
 */
class PitchCorrectionProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.grainSize = 2048;
    this.bufferSize = 8192;
    this.buffers = [];
    this.writeIndex = 0;
    this.phase = 0;
    this.dry = 1;
  }

  static get parameterDescriptors() {
    return [
      {
        name: "semitones",
        defaultValue: 0,
        minValue: -24,
        maxValue: 24,
        automationRate: "k-rate",
      },
    ];
  }

  ensureBuffers(count) {
    while (this.buffers.length < count) {
      this.buffers.push(new Float32Array(this.bufferSize));
    }
  }

  readAt(buffer, position) {
    const size = this.bufferSize;
    let x = position % size;
    if (x < 0) x += size;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const i1 = i0 + 1 < size ? i0 + 1 : 0;
    return buffer[i0] * (1 - frac) + buffer[i1] * frac;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0 || !output[0]) return true;

    const frames = output[0].length;
    const channels = Math.max(input && input.length ? input.length : 0, output.length);
    this.ensureBuffers(channels);

    const semis = parameters.semitones;
    const fadeStep = 1 / Math.max(1, sampleRate * 0.01);
    const grain = this.grainSize;

    for (let i = 0; i < frames; i++) {
      let semitones = semis && semis.length > 1 ? semis[i] : semis && semis.length ? semis[0] : 0;
      if (!Number.isFinite(semitones)) semitones = 0;
      const ratio = Math.pow(2, semitones / 12);

      for (let c = 0; c < channels; c++) {
        const data = input && input[c];
        const sample = data && Number.isFinite(data[i]) ? data[i] : 0;
        this.buffers[c][this.writeIndex] = sample;
      }

      this.phase += 1 - ratio;
      this.phase = ((this.phase % grain) + grain) % grain;
      const phaseB = (this.phase + grain * 0.5) % grain;
      const w1 = 0.5 * (1 - Math.cos((2 * Math.PI * this.phase) / grain));
      const w2 = 0.5 * (1 - Math.cos((2 * Math.PI * phaseB) / grain));
      const delayA = grain * 0.5 + this.phase;
      const delayB = grain * 0.5 + phaseB;

      const targetDry = Math.abs(semitones) < 0.01 ? 1 : 0;
      if (this.dry < targetDry) this.dry = Math.min(targetDry, this.dry + fadeStep);
      else if (this.dry > targetDry) this.dry = Math.max(targetDry, this.dry - fadeStep);

      for (let c = 0; c < output.length; c++) {
        const data = input && input[c];
        const dry = data && Number.isFinite(data[i]) ? data[i] : 0;
        const buffer = this.buffers[c] || this.buffers[0];
        const wet =
          w1 * this.readAt(buffer, this.writeIndex - delayA) +
          w2 * this.readAt(buffer, this.writeIndex - delayB);
        output[c][i] = dry * this.dry + wet * (1 - this.dry);
      }

      this.writeIndex += 1;
      if (this.writeIndex >= this.bufferSize) this.writeIndex = 0;
    }

    return true;
  }
}

registerProcessor("pitch-correction", PitchCorrectionProcessor);
