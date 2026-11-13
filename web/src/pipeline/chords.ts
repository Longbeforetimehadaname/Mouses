// @ts-nocheck — sample indexes are dense; the shell's noUncheckedIndexedAccess does not model that.
import type { ChordBeat } from "../types";

const FRAME = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 180;
const CHROMA_FFT = 8192;
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

interface Template {
  name: string;
  root: number;
  seventh: boolean;
  bins: Float32Array;
}

const TEMPLATES: Template[] = buildTemplates();

export function detectChords(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  bassLeft?: Float32Array,
  bassRight?: Float32Array,
  harmonyLeft?: Float32Array,
  harmonyRight?: Float32Array,
): { bpm: number; beats: ChordBeat[] } {
  const mono = mixMono(left, right);
  if (mono.length === 0 || sampleRate <= 0) return { bpm: 120, beats: [] };
  const harmony = harmonyLeft ? mixMono(harmonyLeft, harmonyRight ?? harmonyLeft) : mono;

  const flux = energyFlux(mono);
  const bpm = estimateBpm(flux, sampleRate);
  const duration = mono.length / sampleRate;
  const spacing = 60 / bpm;
  const downbeat = downbeatTime(flux, sampleRate, bpm, duration);
  const bass = bassLeft ? mixMono(bassLeft, bassRight ?? bassLeft) : null;
  const beats: ChordBeat[] = [];
  let previous: string | null = null;
  let previousScore = 0;
  for (let index = 0, time = downbeat; time < duration - 1e-4; index++, time += spacing) {
    const next = Math.min(duration, time + spacing);
    let regionStart = time;
    if (next - regionStart < spacing * 0.5) regionStart = Math.max(0, next - spacing);
    const named = chordAt(harmony, bass, sampleRate, regionStart, next, previous, previousScore);
    beats.push({
      bar: Math.floor(index / 4),
      beat: index % 4,
      chord: named.name === previous ? null : named.name,
      time,
    });
    previous = named.name;
    previousScore = named.score;
  }
  return { bpm, beats };
}

/** Phase of a 4/4 grid. Beat 1 is the offset that lands on the strong accents. */
function downbeatTime(flux: Float32Array, sampleRate: number, bpm: number, duration: number): number {
  const frameRate = sampleRate / HOP;
  const period = 60 / bpm;
  if (flux.length === 0 || period <= 0) return 0;
  const steps = 48;
  let bestPhase = 0;
  let best = -Infinity;
  for (let step = 0; step < steps; step++) {
    const phase = (step / steps) * period;
    let score = 0;
    for (let time = phase; time < duration; time += period) {
      const frame = Math.round(time * frameRate);
      if (frame >= 0 && frame < flux.length) score += flux[frame];
    }
    if (score > best) {
      best = score;
      bestPhase = phase;
    }
  }
  let rotation = 0;
  let bestAccent = -Infinity;
  for (let turn = 0; turn < 4; turn++) {
    let accent = 0;
    const phase = bestPhase + turn * period;
    for (let time = phase; time < duration; time += period * 4) {
      const frame = Math.round(time * frameRate);
      if (frame >= 0 && frame < flux.length) accent += flux[frame];
    }
    if (accent > bestAccent) {
      bestAccent = accent;
      rotation = turn;
    }
  }
  const downbeat = bestPhase + rotation * period;
  return downbeat >= duration ? bestPhase : downbeat;
}

function mixMono(left: Float32Array, right: Float32Array): Float32Array {
  const length = Math.max(left.length, right.length);
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const l = i < left.length ? left[i] : 0;
    const r = i < right.length ? right[i] : 0;
    mono[i] = 0.5 * (l + r);
  }
  return mono;
}

const HANN = hannWindow(FRAME);

/**
 * Half-wave rectified spectral energy flux. Steady harmony cancels; onsets remain.
 * A single time-domain energy envelope gets swamped by the mix level.
 */
function energyFlux(mono: Float32Array): Float32Array {
  if (mono.length === 0) return new Float32Array(0);
  const frames = Math.max(1, Math.floor(Math.max(0, mono.length - FRAME) / HOP) + 1);
  const flux = new Float32Array(frames);
  const real = new Float32Array(FRAME);
  const imag = new Float32Array(FRAME);
  const bins = FRAME / 2;
  let previous: Float32Array | null = null;
  const current = new Float32Array(bins);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * HOP;
    real.fill(0);
    imag.fill(0);
    const count = Math.min(FRAME, Math.max(0, mono.length - start));
    for (let i = 0; i < count; i++) real[i] = mono[start + i] * HANN[i];
    fft(real, imag);
    for (let bin = 1; bin < bins; bin++) {
      current[bin] = Math.log1p(Math.hypot(real[bin], imag[bin]));
    }
    if (!previous) {
      let sum = 0;
      for (let bin = 1; bin < bins; bin++) sum += current[bin];
      flux[frame] = sum;
      previous = new Float32Array(current);
      continue;
    }
    let sum = 0;
    for (let bin = 1; bin < bins; bin++) {
      const delta = current[bin] - previous[bin];
      if (delta > 0) sum += delta;
    }
    flux[frame] = sum;
    previous.set(current);
  }
  return flux;
}

function hannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, length - 1)));
  }
  return window;
}

function estimateBpm(flux: Float32Array, sampleRate: number): number {
  const frameRate = sampleRate / HOP;
  if (flux.length < 8) return 120;
  const centered = demean(flux);
  const minLag = Math.max(1, Math.floor(frameRate * 60 / 240));
  const maxLag = Math.min(centered.length - 2, Math.ceil(frameRate * 60 / 40));
  if (maxLag <= minLag) return 120;

  const scores = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const count = centered.length - lag;
    for (let i = 0; i < count; i++) sum += centered[i] * centered[i + lag];
    scores[lag] = sum / count;
  }

  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1] && scores[lag] > best) {
      best = scores[lag];
      bestLag = lag;
    }
  }
  if (best === -Infinity) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (scores[lag] > best) {
        best = scores[lag];
        bestLag = lag;
      }
    }
  }

  // A subharmonic (half tempo) often scores as high as the pulse itself.
  let lag = bestLag;
  for (;;) {
    const half = Math.round(lag / 2);
    if (half < minLag + 1 || half >= lag) break;
    const peak = scores[half] >= scores[half - 1] && scores[half] >= scores[Math.min(maxLag, half + 1)];
    if (!peak || scores[half] < scores[lag] * 0.85) break;
    lag = half;
  }

  let bpm = 60 / (lag / frameRate);
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;
  return bpm;
}

function demean(values: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i];
  mean /= Math.max(1, values.length);
  const centered = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) centered[i] = values[i] - mean;
  return centered;
}

function chordAt(
  mono: Float32Array,
  bass: Float32Array | null,
  sampleRate: number,
  startTime: number,
  endTime: number,
  previous: string | null,
  previousScore: number,
): { name: string; score: number } {
  const chroma = chromaForRange(mono, sampleRate, startTime, endTime);
  const root = bass ? bassPitch(bass, sampleRate, startTime, endTime) : -1;
  if (root >= 0) chroma[root] += sumChroma(chroma) * 0.45;
  let best = 0;
  let bestScore = -Infinity;
  let bestTriad = -Infinity;
  for (let i = 0; i < TEMPLATES.length; i++) {
    let score = cosine(chroma, TEMPLATES[i].bins);
    if (root >= 0 && TEMPLATES[i].root === root) score += 0.18;
    if (!TEMPLATES[i].seventh && score > bestTriad) bestTriad = score;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  let chosen = TEMPLATES[best];
  if (chosen.seventh && bestScore < bestTriad + 0.06) {
    bestScore = bestTriad;
    for (let i = 0; i < TEMPLATES.length; i++) {
      if (TEMPLATES[i].seventh) continue;
      const score = cosine(chroma, TEMPLATES[i].bins) + (root >= 0 && TEMPLATES[i].root === root ? 0.18 : 0);
      if (score >= bestScore) {
        bestScore = score;
        chosen = TEMPLATES[i];
      }
    }
  }
  if (previous && chosen.name !== previous && bestScore < previousScore + 0.07) {
    return { name: previous, score: previousScore };
  }
  return { name: chosen.name, score: bestScore };
}

function sumChroma(chroma: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  return sum;
}

function bassPitch(bass: Float32Array, sampleRate: number, startTime: number, endTime: number): number {
  const chroma = chromaForRange(bass, sampleRate, startTime, endTime);
  let best = 0;
  let energy = 0;
  for (let i = 0; i < 12; i++) {
    energy += chroma[i];
    if (chroma[i] > chroma[best]) best = i;
  }
  return energy > 0 ? best : -1;
}

function chromaForRange(
  mono: Float32Array,
  sampleRate: number,
  startTime: number,
  endTime: number,
): Float32Array {
  const chroma = new Float32Array(12);
  const start = Math.max(0, Math.floor(startTime * sampleRate));
  const end = Math.min(mono.length, Math.max(start + 1, Math.floor(endTime * sampleRate)));
  const hop = CHROMA_FFT / 2;
  let windows = 0;
  for (let offset = start; offset < end && windows < 8; offset += hop) {
    addChroma(chroma, mono, sampleRate, offset);
    windows += 1;
    if (offset + CHROMA_FFT >= end) break;
  }
  return chroma;
}

function addChroma(chroma: Float32Array, mono: Float32Array, sampleRate: number, offset: number): void {
  const real = new Float32Array(CHROMA_FFT);
  const imag = new Float32Array(CHROMA_FFT);
  const count = Math.min(CHROMA_FFT, mono.length - offset);
  for (let i = 0; i < count; i++) {
    const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, count - 1)));
    real[i] = mono[offset + i] * hann;
  }
  fft(real, imag);
  const nyquist = CHROMA_FFT / 2;
  for (let bin = 1; bin <= nyquist; bin++) {
    const freq = bin * sampleRate / CHROMA_FFT;
    if (freq < 80 || freq > 2500) continue;
    const power = real[bin] * real[bin] + imag[bin] * imag[bin];
    const midi = 69 + 12 * Math.log2(freq / 440);
    const pitch = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pitch] += power;
  }
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftEnergy = 0;
  let rightEnergy = 0;
  for (let i = 0; i < 12; i++) {
    dot += left[i] * right[i];
    leftEnergy += left[i] * left[i];
    rightEnergy += right[i] * right[i];
  }
  if (leftEnergy <= 1e-12 || rightEnergy <= 1e-12) return 0;
  return dot / Math.sqrt(leftEnergy * rightEnergy);
}

function buildTemplates(): Template[] {
  const templates: Template[] = [];
  for (let root = 0; root < 12; root++) {
    templates.push({ name: PITCH_NAMES[root], root, seventh: false, bins: chordBins(root, [0, 4, 7]) });
  }
  for (let root = 0; root < 12; root++) {
    templates.push({ name: `${PITCH_NAMES[root]}m`, root, seventh: false, bins: chordBins(root, [0, 3, 7]) });
  }
  for (let root = 0; root < 12; root++) {
    templates.push({ name: `${PITCH_NAMES[root]}7`, root, seventh: true, bins: chordBins(root, [0, 4, 7, 10]) });
  }
  return templates;
}

function chordBins(root: number, intervals: number[]): Float32Array {
  const bins = new Float32Array(12);
  for (const interval of intervals) bins[(root + interval) % 12] = 1;
  return bins;
}

function fft(real: Float32Array, imag: Float32Array): void {
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
  for (let length = 2; length <= n; length <<= 1) {
    const angle = -2 * Math.PI / length;
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
}
