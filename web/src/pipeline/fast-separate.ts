// @ts-nocheck — sample indexes are dense; the shell's noUncheckedIndexedAccess does not model that.
// Spleeter 4-stem at 44.1 kHz (periodic Hann, n_fft 4096, hop 1024, 1024 bins).
// Guitar and rest are a harmonic / percussive split of the "other" stem, so the
// five masks still sum to 1 and are not copies of the mix.

const N_FFT = 4096;
const HOP = 1024;
const SPLIT = 512;
const FREQ = 1024;
const BINS = N_FFT / 2 + 1;
const PAD = N_FFT - HOP;
const IDS = ["drums", "vocals", "bass", "guitar", "rest"];

const WINDOW = new Float32Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  WINDOW[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N_FFT));
}

function emptyStems(length) {
  const stems = {};
  for (const id of IDS) {
    stems[id] = { left: new Float32Array(length), right: new Float32Array(length) };
  }
  return stems;
}

function sanitize(data) {
  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (!Number.isFinite(value) || value < 0) data[i] = 0;
  }
  return data;
}

// Bass notes Spleeter files under "other" never reach the bass stem. A low-pass
// does not sound like bass: the harmonics that make the note recognizable stay
// behind. Follow each low fundamental through its harmonic series and move
// that series from other into bass.
const RATE = 44100;

function claimBassLine(bass, source, frames, lowMidi, highMidi) {
  for (let channel = 0; channel < 2; channel++) {
    const base = channel * SPLIT * FREQ;
    for (let frame = 0; frame < frames; frame++) {
      const row = base + frame * FREQ;
      let low = 0;
      for (let bin = 1; bin < 28; bin++) low += source[row + bin];
      let bestScore = 0;
      let bestF0 = 0;
      for (let midi = lowMidi; midi <= highMidi; midi++) {
        const f0 = 440 * 2 ** ((midi - 69) / 12);
        const bin0 = Math.round((f0 * N_FFT) / RATE);
        if (bin0 < 2 || bin0 >= FREQ - 1) continue;
        const fundamental = source[row + bin0];
        if (fundamental < source[row + bin0 - 1] * 0.8 || fundamental < source[row + bin0 + 1] * 0.8) continue;
        let score = 0;
        let partials = 0;
        for (let harmonic = 1; harmonic <= 8; harmonic++) {
          const bin = Math.round((f0 * harmonic * N_FFT) / RATE);
          if (bin < 1 || bin >= FREQ) break;
          const mag = source[row + bin];
          score += mag / harmonic;
          if (mag > fundamental * 0.12) partials++;
        }
        if (partials >= 3 && score > bestScore) {
          bestScore = score;
          bestF0 = f0;
        }
      }
      if (bestF0 <= 0 || bestScore < Math.max(low * 0.05, 0.5)) continue;
      for (let harmonic = 1; harmonic <= 10; harmonic++) {
        const center = (bestF0 * harmonic * N_FFT) / RATE;
        if (center >= FREQ) break;
        const start = Math.max(1, Math.floor(center - 1));
        const end = Math.min(FREQ - 1, Math.ceil(center + 1));
        for (let bin = start; bin <= end; bin++) {
          const distance = Math.abs(bin - center);
          const take = distance <= 0.6 ? 0.92 : 0.45;
          const amount = source[row + bin] * take;
          source[row + bin] -= amount;
          bass[row + bin] += amount;
        }
      }
    }
  }
}

function fft(real, imag, inverse) {
  const n = real.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const swapReal = real[i];
      real[i] = real[j];
      real[j] = swapReal;
      const swapImag = imag[i];
      imag[i] = imag[j];
      imag[j] = swapImag;
    }
  }
  const sign = inverse ? 1 : -1;
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (sign * 2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      const half = length >> 1;
      for (let k = 0; k < half; k++) {
        const evenReal = real[start + k];
        const evenImag = imag[start + k];
        const oddIndex = start + k + half;
        const oddReal = real[oddIndex] * twiddleReal - imag[oddIndex] * twiddleImag;
        const oddImag = real[oddIndex] * twiddleImag + imag[oddIndex] * twiddleReal;
        real[start + k] = evenReal + oddReal;
        imag[start + k] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

function irfft(specReal, specImag, timeReal, scratchImag) {
  timeReal.fill(0);
  scratchImag.fill(0);
  timeReal[0] = specReal[0];
  timeReal[N_FFT / 2] = specReal[N_FFT / 2];
  for (let bin = 1; bin < N_FFT / 2; bin++) {
    timeReal[bin] = specReal[bin];
    scratchImag[bin] = specImag[bin];
    timeReal[N_FFT - bin] = specReal[bin];
    scratchImag[N_FFT - bin] = -specImag[bin];
  }
  fft(timeReal, scratchImag, true);
}

function blurTime(source, frames, bins, radius) {
  const out = new Float32Array(frames * bins);
  const prefix = new Float32Array(frames + 1);
  for (let bin = 0; bin < bins; bin++) {
    let sum = 0;
    for (let frame = 0; frame < frames; frame++) {
      sum += source[frame * bins + bin];
      prefix[frame + 1] = sum;
    }
    for (let frame = 0; frame < frames; frame++) {
      const start = Math.max(0, frame - radius);
      const end = Math.min(frames - 1, frame + radius);
      out[frame * bins + bin] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
    }
  }
  return out;
}

function blurFreq(source, frames, bins, radius) {
  const out = new Float32Array(frames * bins);
  const prefix = new Float32Array(bins + 1);
  for (let frame = 0; frame < frames; frame++) {
    const row = frame * bins;
    let sum = 0;
    for (let bin = 0; bin < bins; bin++) {
      sum += source[row + bin];
      prefix[bin + 1] = sum;
    }
    for (let bin = 0; bin < bins; bin++) {
      const start = Math.max(0, bin - radius);
      const end = Math.min(bins - 1, bin + radius);
      out[row + bin] = (prefix[end + 1] - prefix[start]) / (end - start + 1);
    }
  }
  return out;
}

// Soft harmonic mask of one Spleeter magnitude estimate. 1 is harmonic (guitar),
// 0 is percussive (rest). The two pieces sum back to the other stem.
function harmonicRatio(estimate, channel, frames) {
  const mag = new Float32Array(frames * FREQ);
  const base = channel * SPLIT * FREQ;
  for (let frame = 0; frame < frames; frame++) {
    mag.set(estimate.subarray(base + frame * FREQ, base + (frame + 1) * FREQ), frame * FREQ);
  }
  const harmonic = blurTime(mag, frames, FREQ, 12);
  const percussive = blurFreq(mag, frames, FREQ, 16);
  const ratio = new Float32Array(frames * FREQ);
  for (let i = 0; i < ratio.length; i++) {
    const harmonicPower = harmonic[i] * harmonic[i];
    const percussivePower = percussive[i] * percussive[i];
    ratio[i] = harmonicPower / (harmonicPower + percussivePower + 1e-12);
  }
  return ratio;
}

function overlapAdd(destination, time, frame, length) {
  const at = frame * HOP - PAD;
  for (let i = 0; i < N_FFT; i++) {
    const index = at + i;
    if (index < 0 || index >= length) continue;
    destination[index] += time[i] * WINDOW[i];
  }
}

function accumulateWeight(weight, frame, length) {
  const at = frame * HOP - PAD;
  for (let i = 0; i < N_FFT; i++) {
    const index = at + i;
    if (index < 0 || index >= length) continue;
    weight[index] += WINDOW[i] * WINDOW[i];
  }
}

/**
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {(stem: number, magnitudes: Float32Array) => Promise<Float32Array>} runStem
 *   stem 0 vocals, 1 drums, 2 bass, 3 other. Magnitudes are [2, 1, 512, 1024].
 * @param {(fraction: number) => void} [onProgress]
 */
export async function fastSeparate(left, right, runStem, onProgress) {
  const length = Math.max(left.length, right.length);
  const stems = emptyStems(length);
  if (length === 0) {
    onProgress?.(1);
    return stems;
  }

  const frameCount = Math.ceil((PAD + length) / HOP);
  const splits = Math.ceil(frameCount / SPLIT);
  const weight = new Float32Array(length);
  const sources = [left, right];
  const specReal = [new Float32Array(SPLIT * BINS), new Float32Array(SPLIT * BINS)];
  const specImag = [new Float32Array(SPLIT * BINS), new Float32Array(SPLIT * BINS)];
  const magnitudes = new Float32Array(2 * SPLIT * FREQ);
  const fftReal = new Float32Array(N_FFT);
  const fftImag = new Float32Array(N_FFT);
  const destinations = [
    [stems.vocals.left, stems.vocals.right],
    [stems.drums.left, stems.drums.right],
    [stems.bass.left, stems.bass.right],
    [stems.guitar.left, stems.guitar.right],
    [stems.rest.left, stems.rest.right],
  ];
  const time = new Float32Array(N_FFT);
  const scratchImag = new Float32Array(N_FFT);
  const maskedReal = new Float32Array(BINS);
  const maskedImag = new Float32Array(BINS);
  const stemMask = [new Float32Array(FREQ), new Float32Array(FREQ), new Float32Array(FREQ), new Float32Array(FREQ)];
  const meanMask = [0, 0, 0, 0];

  for (let split = 0; split < splits; split++) {
    const frame0 = split * SPLIT;
    const count = Math.min(SPLIT, frameCount - frame0);
    magnitudes.fill(0);

    for (let channel = 0; channel < 2; channel++) {
      const samples = sources[channel];
      for (let frame = 0; frame < count; frame++) {
        const at = (frame0 + frame) * HOP - PAD;
        for (let i = 0; i < N_FFT; i++) {
          const index = at + i;
          fftReal[i] = index >= 0 && index < samples.length ? samples[index] * WINDOW[i] : 0;
          fftImag[i] = 0;
        }
        fft(fftReal, fftImag, false);
        const specBase = frame * BINS;
        specReal[channel].set(fftReal.subarray(0, BINS), specBase);
        specImag[channel].set(fftImag.subarray(0, BINS), specBase);
        const magBase = channel * SPLIT * FREQ + frame * FREQ;
        for (let bin = 0; bin < FREQ; bin++) {
          magnitudes[magBase + bin] = Math.hypot(fftReal[bin], fftImag[bin]);
        }
      }
    }

    const estimates = new Array(4);
    for (let stem = 0; stem < 4; stem++) estimates[stem] = sanitize(await runStem(stem, magnitudes));
    // "other" holds bass guitar the 4-stem net missed. Vocals also swallow
    // fundamentals below the singing range; those partials belong to the bass.
    claimBassLine(estimates[2], estimates[3], count, 28, 47);
    claimBassLine(estimates[2], estimates[0], count, 28, 43);
    const ratios = [harmonicRatio(estimates[3], 0, count), harmonicRatio(estimates[3], 1, count)];

    for (let frame = 0; frame < count; frame++) {
      const globalFrame = frame0 + frame;
      for (let channel = 0; channel < 2; channel++) {
        const magBase = channel * SPLIT * FREQ + frame * FREQ;
        const ratio = ratios[channel];
        const ratioBase = frame * FREQ;
        meanMask[0] = 0;
        meanMask[1] = 0;
        meanMask[2] = 0;
        meanMask[3] = 0;
        let meanRatio = 0;
        for (let bin = 0; bin < FREQ; bin++) {
          let denom = 1e-10;
          const power = [0, 0, 0, 0];
          for (let stem = 0; stem < 4; stem++) {
            const value = estimates[stem][magBase + bin];
            const squared = value * value;
            power[stem] = squared;
            denom += squared;
          }
          for (let stem = 0; stem < 4; stem++) {
            const mask = (power[stem] + 2.5e-11) / denom;
            stemMask[stem][bin] = mask;
            meanMask[stem] += mask;
          }
          meanRatio += ratio[ratioBase + bin];
        }
        for (let stem = 0; stem < 4; stem++) meanMask[stem] /= FREQ;
        meanRatio /= FREQ;

        const specBase = frame * BINS;
        const mixReal = specReal[channel];
        const mixImag = specImag[channel];
        for (let output = 0; output < 5; output++) {
          for (let bin = 0; bin < BINS; bin++) {
            let mask;
            if (output < 3) {
              mask = bin < FREQ ? stemMask[output][bin] : meanMask[output];
            } else {
              const other = bin < FREQ ? stemMask[3][bin] : meanMask[3];
              const part = bin < FREQ ? ratio[ratioBase + bin] : meanRatio;
              mask = output === 3 ? other * part : other * (1 - part);
            }
            maskedReal[bin] = mixReal[specBase + bin] * mask;
            maskedImag[bin] = mixImag[specBase + bin] * mask;
          }
          irfft(maskedReal, maskedImag, time, scratchImag);
          overlapAdd(destinations[output][channel], time, globalFrame, length);
        }
      }
      accumulateWeight(weight, globalFrame, length);
    }
    onProgress?.((split + 1) / splits);
  }

  for (const id of IDS) {
    const stem = stems[id];
    scale(stem.left, weight);
    scale(stem.right, weight);
  }
  return stems;
}

function scale(channel, weight) {
  const length = Math.min(channel.length, weight.length);
  for (let i = 0; i < length; i++) {
    const divider = weight[i];
    if (divider > 1e-8) channel[i] /= divider;
  }
}
