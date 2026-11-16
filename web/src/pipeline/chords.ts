// @ts-nocheck — sample indexes are dense; the shell's noUncheckedIndexedAccess does not model that.
import type { ChordBeat } from "../types";

const FRAME = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 180;
const CHROMA_FFT = 8192;
const CHROMA_HOP = 2048;
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

// A new triad has to clear this, and beat the chord already sounding, or the beat stays put.
const START_SCORE = 0.76;
const STRONG_SCORE = 0.72;
const CHANGE_MARGIN = 0.08;
// The 5th partial of the root sits a little flat of the major third, so a near-tie goes to major.
const MAJOR_BIAS = 0.1;
const BASS_ROOT = 0.06;
const BASS_FIFTH = 0.018;
const BASS_THIRD = 0.012;

interface Triad {
  name: string;
  root: number;
  minor: boolean;
  score: number;
}

interface BeatView {
  time: number;
  chroma: Float32Array;
  bassPc: number;
  bassConf: number;
  best: Triad | null;
}

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

  const bass = bassLeft ? mixMono(bassLeft, bassRight ?? bassLeft) : null;
  let harmony = harmonyLeft ? mixMono(harmonyLeft, harmonyRight ?? harmonyLeft) : mono;
  if (rms(harmony) < 0.004) harmony = mono;
  harmony = cancelBleed(harmony, bass);

  const onsets = energyFlux(mono, sampleRate);
  const bpm = estimateBpm(onsets.full, sampleRate);
  const duration = mono.length / sampleRate;
  const spacing = 60 / bpm;
  const phase = beatPhase(onsets.full, sampleRate, bpm, duration);
  const tuning = estimateSongTuning(harmony, sampleRate);
  const observed: BeatView[] = [];
  for (let time = phase; time < duration - 1e-4; time += spacing) {
    const end = Math.min(duration, time + spacing);
    observed.push(observeBeat(harmony, bass, sampleRate, time, end, tuning));
  }
  if (observed.length === 0) return { bpm, beats: [] };

  const scale = songScale(observed);
  for (const view of observed) view.best = bestChord(view.chroma, view.bassPc, view.bassConf, scale);
  const smoothed = holdChords(observed, scale);
  const rotation = chooseRotation(smoothed, observed, onsets.low, sampleRate);
  const beats: ChordBeat[] = [];
  let previous: string | null = null;
  for (let index = 0; rotation + index < smoothed.length; index++) {
    const chord = smoothed[rotation + index];
    const name = chord ? chord.name : null;
    const shown = name && name !== previous ? name : null;
    if (name) previous = name;
    const view = observed[rotation + index];
    beats.push({
      bar: Math.floor(index / 4),
      beat: index % 4,
      chord: shown,
      time: view ? view.time : 0,
    });
  }
  return { bpm, beats };
}

/**
 * An uncertain beat keeps the chord that is already sounding. A new chord is
 * written on the beat it starts when it beats the chord already sounding.
 * A milder one has to win twice. There is no absolute score that can veto a
 * chord which has already won that comparison: a real G was staying labeled F
 * whenever its template landed under 0.70.
 */
function holdChords(observed: BeatView[], scale: Uint8Array | null): (Triad | null)[] {
  const labels: (Triad | null)[] = [];
  let held: Triad | null = null;
  let pending: { name: string; index: number } | null = null;
  // A new chord whose flat seventh is the root we just left may only be the previous
  // chord still ringing (F into G). Keep the triad unless the next beat still hears the seventh.
  let seventhHold: { name: string; index: number } | null = null;
  for (let index = 0; index < observed.length; index++) {
    const view = observed[index];
    const best = view ? view.best : null;
    if (seventhHold) {
      if (best && best.name === seventhHold.name) {
        labels[seventhHold.index] = best;
        held = best;
      }
      seventhHold = null;
    }
    if (!held) {
      if (best && best.score >= START_SCORE) held = best;
      labels.push(held);
      continue;
    }
    const carriedSeventh = !!best && !!held && best.name.endsWith("7") && held.root === (best.root + 10) % 12;
    const candidate: Triad | null = carriedSeventh
      ? { name: PITCH_NAMES[best.root] ?? best.name, root: best.root, minor: false, score: best.score - 0.045 }
      : best;
    const same = !!candidate && candidate.name === held.name;
    const stuck = view ? chordScore(view.chroma, held.root, tonesFor(held.name), view.bassPc, view.bassConf, scale) : 0;
    // C and Am share two notes. A quiet Am only has to edge out the C it follows.
    const toRelativeMinor =
      !!candidate &&
      isMinorTriad(candidate.name) &&
      !isMinorTriad(held.name) &&
      candidate.root === (held.root + 9) % 12 &&
      stuck < 0.78;
    const sameRoot = !!candidate && candidate.root === held.root;
    // Dropping the seventh (G7 back to G) has to be clearer than adding one.
    const droppingSeventh = !!candidate && held.name.endsWith("7") && candidate.name === PITCH_NAMES[held.root];
    const margin = toRelativeMinor ? 0 : droppingSeventh ? 0.06 : sameRoot ? 0.03 : CHANGE_MARGIN;
    const needed = stuck + margin;
    const clear = !!candidate && !same && candidate.score >= needed && candidate.score >= 0.5;
    if (!clear) {
      pending = null;
      labels.push(held);
      continue;
    }
    // Decisive on this beat, including a one-beat diminished or seventh.
    if (candidate.score >= STRONG_SCORE || candidate.score >= needed + 0.06) {
      held = candidate;
      pending = null;
      if (carriedSeventh && best) seventhHold = { name: best.name, index };
      labels.push(held);
      continue;
    }
    if (pending && pending.name === candidate.name) {
      held = candidate;
      labels[pending.index] = held;
      pending = null;
      if (carriedSeventh && best) seventhHold = { name: best.name, index };
      labels.push(held);
      continue;
    }
    pending = { name: candidate.name, index };
    labels.push(held);
  }
  return labels;
}

function observeBeat(
  harmony: Float32Array,
  bass: Float32Array | null,
  sampleRate: number,
  start: number,
  end: number,
  tuning: number,
): BeatView {
  const chroma = beatChroma(harmony, sampleRate, start, end, tuning);
  const low = bass ? bassPitch(bass, sampleRate, start, end) : null;
  const bassPc = low ? low.pc : -1;
  const bassConf = low ? low.confidence : 0;
  return {
    time: start,
    chroma,
    bassPc,
    bassConf,
    best: null,
  };
}

function bestChord(
  chroma: Float32Array,
  bassPc: number,
  bassConf: number,
  scale: Uint8Array | null,
): Triad | null {
  let best: Triad | null = null;
  for (let root = 0; root < 12; root++) {
    const majorScore = chordScore(chroma, root, [0, 4, 7], bassPc, bassConf, scale);
    const minorScore = chordScore(chroma, root, [0, 3, 7], bassPc, bassConf, scale);
    const minor = minorScore > majorScore + MAJOR_BIAS;
    let name = minor ? `${PITCH_NAMES[root]}m` : PITCH_NAMES[root];
    let score = minor ? minorScore : majorScore;

    const diminished = chordScore(chroma, root, [0, 3, 6], bassPc, bassConf, scale);
    const flatFifth = chroma[(root + 6) % 12] ?? 0;
    const perfectFifth = chroma[(root + 7) % 12] ?? 0;
    let diminishedName = false;
    if (flatFifth >= 0.12 && flatFifth > perfectFifth * 1.15 && diminished > score + 0.02) {
      name = `${PITCH_NAMES[root]}dim`;
      score = diminished;
      diminishedName = true;
    }

    // A four-note template scores below the triad when the seventh is quieter than the
    // root, which is the normal voicing. Treat a real flat seventh as extra evidence
    // on the major triad instead of a competing template.
    const flatSeventh = chroma[(root + 10) % 12] ?? 0;
    const majorSeventh = chroma[(root + 11) % 12] ?? 0;
    const majorThird = chroma[(root + 4) % 12] ?? 0;
    if (
      !minor &&
      !diminishedName &&
      flatSeventh >= 0.1 &&
      flatSeventh > majorSeventh + 0.04 &&
      flatSeventh >= majorThird * 0.35
    ) {
      name = `${PITCH_NAMES[root]}7`;
      score += 0.045;
    }

    if (!best || score > best.score) best = { name, root, minor: isMinorTriad(name), score };
  }
  return best;
}

function tonesFor(name: string): number[] {
  if (name.endsWith("dim")) return [0, 3, 6];
  if (name.endsWith("7")) return [0, 4, 7, 10];
  return isMinorTriad(name) ? [0, 3, 7] : [0, 4, 7];
}

function isMinorTriad(name: string): boolean {
  return name.endsWith("m") && !name.endsWith("dim");
}

function chordScore(
  chroma: Float32Array,
  root: number,
  tones: readonly number[],
  bassPc: number,
  bassConf: number,
  scale: Uint8Array | null,
): number {
  const third = tones.length > 1 ? tones[1] : 4;
  let dot = 0;
  let energy = 0;
  for (let i = 0; i < 12; i++) {
    const value = chroma[i] ?? 0;
    energy += value * value;
  }
  for (const interval of tones) dot += chroma[(root + interval) % 12] ?? 0;
  if (energy <= 1e-12) return 0;
  // Equal chord tones, so a single bass harmonic cannot impersonate a major triad
  // once its upper partials have been folded back onto the fundamental.
  let score = dot / (Math.sqrt(energy) * Math.sqrt(tones.length));
  if (bassConf >= 0.5 && bassPc >= 0) {
    const bass = ((bassPc % 12) + 12) % 12;
    const fifth = tones.includes(7) ? 7 : tones.includes(6) ? 6 : 7;
    if (bass === root) score += BASS_ROOT * bassConf;
    else if (bass === (root + fifth) % 12) score += BASS_FIFTH * bassConf;
    else if (bass === (root + third) % 12) score += BASS_THIRD * bassConf;
  }
  if (scale) {
    let outside = 0;
    for (const interval of tones) if (!scale[(root + interval) % 12]) outside += 1;
    // A foreign chord (two tones off the song's scale) is not a quiet chord of the key.
    // One outside tone is a seventh or a borrowed chord, and a key change needs those.
    if (outside >= 2) score -= 0.08 * outside;
  }
  return score;
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function songScale(observed: BeatView[]): Uint8Array | null {
  const chroma = new Float32Array(12);
  for (const view of observed) {
    for (let i = 0; i < 12; i++) chroma[i] += view.chroma[i] ?? 0;
  }
  let best = -Infinity;
  let root = 0;
  let minor = false;
  for (let rotation = 0; rotation < 12; rotation++) {
    let majorScore = 0;
    let minorScore = 0;
    for (let i = 0; i < 12; i++) {
      const energy = chroma[(rotation + i) % 12] ?? 0;
      majorScore += energy * (MAJOR_PROFILE[i] ?? 0);
      minorScore += energy * (MINOR_PROFILE[i] ?? 0);
    }
    if (majorScore > best) {
      best = majorScore;
      root = rotation;
      minor = false;
    }
    if (minorScore > best) {
      best = minorScore;
      root = rotation;
      minor = true;
    }
  }
  const scale = new Uint8Array(12);
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  for (const step of steps) scale[(root + step) % 12] = 1;
  return scale;
}

/**
 * Beat 1 is where the harmony changes. A tie keeps the earlier downbeat so a song
 * that starts on a chord is not shifted into the bar.
 */
function chooseRotation(
  labels: (Triad | null)[],
  observed: BeatView[],
  lowFlux: Float32Array,
  sampleRate: number,
): number {
  const frameRate = sampleRate / HOP;
  let bestTurn = 0;
  let bestKey = -Infinity;
  for (let turn = 0; turn < 4; turn++) {
    let onDownbeat = 0;
    let elsewhere = 0;
    let previous: string | null = null;
    for (let index = 0; index < labels.length; index++) {
      const name = labels[index]?.name ?? null;
      if (!name || name === previous) {
        if (name) previous = name;
        continue;
      }
      previous = name;
      const place = ((index - turn) % 4 + 4) % 4;
      if (place === 0) onDownbeat += 1;
      else elsewhere += 1;
    }
    let accent = 0;
    let other = 0;
    for (let index = turn; index < observed.length; index += 4) {
      const at = observed[index];
      if (at) accent += lowAt(lowFlux, at.time, frameRate);
      for (let step = 1; step < 4 && index + step < observed.length; step++) {
        const beat = observed[index + step];
        if (beat) other += lowAt(lowFlux, beat.time, frameRate);
      }
    }
    const balance = accent / (accent + other + 1e-9);
    // One extra change on beat 1 outweighs the accent. A tie stays on the earlier beat.
    const key = onDownbeat * 10 - elsewhere * 3 + balance - turn * 0.5;
    if (key > bestKey) {
      bestKey = key;
      bestTurn = turn;
    }
  }
  return bestTurn;
}

function lowAt(lowFlux: Float32Array, time: number, frameRate: number): number {
  const frame = Math.round(time * frameRate);
  let sum = 0;
  for (let offset = -1; offset <= 1; offset++) {
    const value = lowFlux[frame + offset];
    if (value) sum += value;
  }
  return sum;
}

function beatPhase(flux: Float32Array, sampleRate: number, bpm: number, duration: number): number {
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
  return bestPhase;
}

function beatChroma(
  mono: Float32Array,
  sampleRate: number,
  startTime: number,
  endTime: number,
  tuning: number,
): Float32Array {
  const chroma = new Float32Array(12);
  const start = Math.max(0, Math.floor(startTime * sampleRate));
  const end = Math.min(mono.length, Math.max(start + 1, Math.floor(endTime * sampleRate)));
  if (end - start < 64) return chroma;
  const offsets = frameOffsets(start, end);
  const frames: { freq: number; mag: number }[][] = [];
  const real = new Float32Array(CHROMA_FFT);
  const imag = new Float32Array(CHROMA_FFT);
  const hann = chromaWindow();
  for (const offset of offsets) {
    if (!fillSpectrum(mono, offset, real, imag, hann)) continue;
    frames.push(framePeaks(real, imag, sampleRate));
  }
  for (const peaks of frames) addPeaks(chroma, peaks, tuning);
  normalize(chroma);
  return chroma;
}

/** One tuning for the whole song, from the low notes. High partials are sharp and flip the estimate. */
function estimateSongTuning(mono: Float32Array, sampleRate: number): number {
  const real = new Float32Array(CHROMA_FFT);
  const imag = new Float32Array(CHROMA_FFT);
  const hann = chromaWindow();
  let x = 0;
  let y = 0;
  let weight = 0;
  const hop = Math.max(CHROMA_HOP, Math.floor(sampleRate * 0.25));
  for (let offset = 0; offset + 64 < mono.length; offset += hop) {
    if (!fillSpectrum(mono, offset, real, imag, hann)) break;
    for (const peak of framePeaks(real, imag, sampleRate)) {
      if (peak.freq < 75 || peak.freq > 500) continue;
      const midi = 69 + 12 * Math.log2(peak.freq / 440);
      const deviation = midi - Math.round(midi);
      const angle = deviation * 2 * Math.PI;
      const w = Math.log1p(peak.mag);
      x += Math.cos(angle) * w;
      y += Math.sin(angle) * w;
      weight += w;
    }
  }
  if (weight < 1) return 0;
  const concentration = Math.hypot(x, y) / weight;
  if (concentration < 0.2) return 0;
  return Math.atan2(y, x) / (2 * Math.PI);
}

/** Windows stay inside the beat so a chord change is not mixed with the next bar. */
function frameOffsets(start: number, end: number): number[] {
  const span = end - start;
  if (span <= CHROMA_FFT) {
    const center = start + Math.floor(span / 2);
    return [Math.max(0, center - Math.floor(CHROMA_FFT / 2))];
  }
  const offsets: number[] = [];
  const last = end - CHROMA_FFT;
  for (let offset = start; offset <= last && offsets.length < 8; offset += CHROMA_HOP) offsets.push(offset);
  if (offsets.length === 0) offsets.push(start);
  return offsets;
}

let chromaHann: Float32Array | null = null;
function chromaWindow(): Float32Array {
  if (!chromaHann) chromaHann = hannWindow(CHROMA_FFT);
  return chromaHann;
}

function framePeaks(real: Float32Array, imag: Float32Array, sampleRate: number): { freq: number; mag: number }[] {
  const minBin = Math.max(2, Math.floor((65 * CHROMA_FFT) / sampleRate));
  const maxBin = Math.min(CHROMA_FFT / 2 - 2, Math.ceil((4800 * CHROMA_FFT) / sampleRate));
  const peaks: { freq: number; mag: number }[] = [];
  let maxMag = 0;
  for (let bin = minBin; bin <= maxBin; bin++) {
    const mag = Math.hypot(real[bin] ?? 0, imag[bin] ?? 0);
    if (mag > maxMag) maxMag = mag;
    const prev = Math.hypot(real[bin - 1] ?? 0, imag[bin - 1] ?? 0);
    const next = Math.hypot(real[bin + 1] ?? 0, imag[bin + 1] ?? 0);
    if (mag < prev || mag <= next) continue;
    const freq = peakFreq(bin, prev, mag, next, sampleRate);
    if (freq < 65 || freq > 5000) continue;
    peaks.push({ freq, mag });
  }
  const floor = maxMag * 0.03;
  return peaks.filter((peak) => peak.mag >= floor);
}

function addPeaks(chroma: Float32Array, peaks: { freq: number; mag: number }[], tuning: number): void {
  const claimed = new Uint8Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    if (claimed[i]) continue;
    const fundamental = peaks[i]?.freq ?? 0;
    const fundamentalMag = peaks[i]?.mag ?? 0;
    // Above 700 Hz a peak is a partial of a lower string, not a new chord tone.
    if (fundamental <= 0 || fundamental > 700) continue;
    // Fold the upper partials back onto that fundamental so a harmonic is not a new triad.
    let weight = partialWeight(fundamental, fundamentalMag);
    for (let j = i + 1; j < peaks.length; j++) {
      if (claimed[j]) continue;
      const freq = peaks[j]?.freq ?? 0;
      const mag = peaks[j]?.mag ?? 0;
      const ratio = freq / fundamental;
      const harmonic = Math.round(ratio);
      if (harmonic < 2 || harmonic > 14) continue;
      const cents = Math.abs(1200 * Math.log2(ratio / harmonic));
      const octave = harmonic === 2 || harmonic === 4 || harmonic === 8;
      // The 5th and 7th partials sit flat of the tempered third and seventh.
      const centsLimit = harmonic >= 5 ? 48 : 28;
      if (cents > centsLimit) continue;
      // Below 700 Hz a non-octave harmonic is another note of the chord.
      // The twelfth of a bass G is the D a fifth up; folding it away left G7 looking like a bare third.
      if (freq <= 700 && !octave) continue;
      const explains = fundamentalMag * harmonic >= mag * 0.28;
      if (!octave && !explains) continue;
      claimed[j] = 1;
      weight += partialWeight(freq, mag) * 0.35;
    }
    const midi = 69 + 12 * Math.log2(fundamental / 440) - tuning;
    const pitch = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pitch] += weight;
  }
}

function partialWeight(freq: number, mag: number): number {
  const tilt = freq < 1400 ? 1 : 1400 / freq;
  return Math.log1p(mag) * tilt;
}

function fillSpectrum(
  mono: Float32Array,
  offset: number,
  real: Float32Array,
  imag: Float32Array,
  hann: Float32Array,
): boolean {
  if (offset >= mono.length - 32) return false;
  const count = Math.min(CHROMA_FFT, mono.length - offset);
  real.fill(0);
  imag.fill(0);
  for (let i = 0; i < count; i++) real[i] = (mono[offset + i] ?? 0) * (hann[i] ?? 0);
  fft(real, imag);
  return true;
}

function peakFreq(bin: number, prev: number, mag: number, next: number, sampleRate: number): number {
  const denom = prev - 2 * mag + next;
  let delta = denom === 0 ? 0 : (0.5 * (prev - next)) / denom;
  if (delta > 0.5) delta = 0.5;
  if (delta < -0.5) delta = -0.5;
  return (bin + delta) * sampleRate / CHROMA_FFT;
}

function normalize(chroma: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i] ?? 0;
  if (sum <= 1e-8) return;
  for (let i = 0; i < 12; i++) chroma[i] = (chroma[i] ?? 0) / sum;
}

/**
 * Bass pitch class from the bass stem alone. Used as a tie-break between
 * relative triads (C vs Am), not as the chord root.
 */
function bassPitch(
  bass: Float32Array,
  sampleRate: number,
  startTime: number,
  endTime: number,
): { pc: number; confidence: number } | null {
  const start = Math.max(0, Math.floor(startTime * sampleRate));
  const end = Math.min(bass.length, Math.floor(endTime * sampleRate));
  const span = end - start;
  if (span < sampleRate * 0.06) return null;
  const factor = Math.max(1, Math.floor(sampleRate / 3000));
  const take = Math.min(span, Math.floor(sampleRate * 0.35));
  const offset = start + Math.max(0, Math.floor((span - take) / 3));
  const count = Math.floor(take / factor);
  if (count < 48) return null;
  const samples = new Float32Array(count);
  const alpha = 1 - Math.exp((-2 * Math.PI * 220) / (sampleRate / factor));
  let low = 0;
  let mean = 0;
  for (let i = 0; i < count; i++) {
    let mixed = 0;
    const at = offset + i * factor;
    for (let k = 0; k < factor; k++) mixed += bass[at + k] ?? 0;
    low += alpha * (mixed / factor - low);
    samples[i] = low;
    mean += low;
  }
  mean /= count;
  let energy = 0;
  for (let i = 0; i < count; i++) {
    samples[i] -= mean;
    energy += (samples[i] ?? 0) * (samples[i] ?? 0);
  }
  if (energy / count < 1e-7) return null;
  const rate = sampleRate / factor;
  const minLag = Math.max(2, Math.floor(rate / 280));
  const maxLag = Math.min(count - 3, Math.floor(rate / 36));
  if (maxLag <= minLag + 1) return null;
  const diff = new Float32Array(maxLag + 1);
  for (let tau = minLag; tau <= maxLag; tau++) {
    let sum = 0;
    const limit = count - tau;
    for (let i = 0; i < limit; i += 2) {
      const delta = (samples[i] ?? 0) - (samples[i + tau] ?? 0);
      sum += delta * delta;
    }
    diff[tau] = sum;
  }
  const cmnd = new Float32Array(maxLag + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    running += diff[tau] ?? 0;
    cmnd[tau] = running > 0 ? ((diff[tau] ?? 0) * tau) / running : 1;
  }
  let tau = -1;
  for (let i = minLag; i <= maxLag; i++) {
    if ((cmnd[i] ?? 1) < 0.2) {
      while (i + 1 <= maxLag && (cmnd[i + 1] ?? 1) < (cmnd[i] ?? 1)) i++;
      tau = i;
      break;
    }
  }
  if (tau < 0) {
    let best = minLag;
    for (let i = minLag + 1; i <= maxLag; i++) {
      if ((cmnd[i] ?? 1) < (cmnd[best] ?? 1)) best = i;
    }
    if ((cmnd[best] ?? 1) > 0.32) return null;
    tau = best;
  }
  const prev = cmnd[tau - 1] ?? cmnd[tau] ?? 1;
  const next = cmnd[tau + 1] ?? cmnd[tau] ?? 1;
  const mid = cmnd[tau] ?? 1;
  const denom = prev - 2 * mid + next;
  let delta = denom === 0 ? 0 : (0.5 * (prev - next)) / denom;
  if (delta > 0.5) delta = 0.5;
  if (delta < -0.5) delta = -0.5;
  const freq = rate / (tau + delta);
  if (freq < 34 || freq > 320) return null;
  const midi = 69 + 12 * Math.log2(freq / 440);
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  return { pc, confidence: Math.max(0, Math.min(1, 1 - mid)) };
}

/** Remove the bass stem from the harmony when it was mixed in. A separate guitar stem is left alone. */
function cancelBleed(harmony: Float32Array, bass: Float32Array | null): Float32Array {
  if (!bass) return harmony;
  const length = Math.min(harmony.length, bass.length);
  if (length < 32) return harmony;
  let dot = 0;
  let bassEnergy = 0;
  let harmEnergy = 0;
  const step = 16;
  for (let i = 0; i < length; i += step) {
    const h = harmony[i] ?? 0;
    const b = bass[i] ?? 0;
    dot += h * b;
    bassEnergy += b * b;
    harmEnergy += h * h;
  }
  if (bassEnergy < 1e-8 || harmEnergy < 1e-8 || dot <= 0) return harmony;
  const correlation = dot / Math.sqrt(bassEnergy * harmEnergy);
  if (correlation < 0.5) return harmony;
  const gain = dot / bassEnergy;
  const out = new Float32Array(harmony.length);
  for (let i = 0; i < harmony.length; i++) {
    const b = i < bass.length ? (bass[i] ?? 0) : 0;
    out[i] = (harmony[i] ?? 0) - gain * b;
  }
  return out;
}

function rms(mono: Float32Array): number {
  if (mono.length === 0) return 0;
  let energy = 0;
  const step = 32;
  let count = 0;
  for (let i = 0; i < mono.length; i += step) {
    const sample = mono[i] ?? 0;
    energy += sample * sample;
    count += 1;
  }
  return Math.sqrt(energy / Math.max(1, count));
}

function mixMono(left: Float32Array, right: Float32Array): Float32Array {
  const length = Math.max(left.length, right.length);
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const l = i < left.length ? (left[i] ?? 0) : 0;
    const r = i < right.length ? (right[i] ?? 0) : 0;
    mono[i] = 0.5 * (l + r);
  }
  return mono;
}

const HANN = hannWindow(FRAME);

/**
 * Half-wave spectral flux. The first frame is not an onset: there is no previous
 * spectrum, and treating the whole spectrum as new pins the grid to time zero.
 */
function energyFlux(mono: Float32Array, sampleRate: number): { full: Float32Array; low: Float32Array } {
  if (mono.length === 0) return { full: new Float32Array(0), low: new Float32Array(0) };
  const frames = Math.max(1, Math.floor(Math.max(0, mono.length - FRAME) / HOP) + 1);
  const full = new Float32Array(frames);
  const low = new Float32Array(frames);
  const real = new Float32Array(FRAME);
  const imag = new Float32Array(FRAME);
  const bins = FRAME / 2;
  const lowBin = Math.max(2, Math.floor((200 * FRAME) / sampleRate));
  let previous: Float32Array | null = null;
  const current = new Float32Array(bins);
  for (let frame = 0; frame < frames; frame++) {
    const start = frame * HOP;
    real.fill(0);
    imag.fill(0);
    const count = Math.min(FRAME, Math.max(0, mono.length - start));
    for (let i = 0; i < count; i++) real[i] = (mono[start + i] ?? 0) * (HANN[i] ?? 0);
    fft(real, imag);
    for (let bin = 1; bin < bins; bin++) current[bin] = Math.log1p(Math.hypot(real[bin] ?? 0, imag[bin] ?? 0));
    if (!previous) {
      previous = new Float32Array(current);
      continue;
    }
    let sum = 0;
    let lowSum = 0;
    for (let bin = 1; bin < bins; bin++) {
      const delta = (current[bin] ?? 0) - (previous[bin] ?? 0);
      if (delta > 0) {
        sum += delta;
        if (bin <= lowBin) lowSum += delta;
      }
    }
    full[frame] = Math.log1p(sum);
    low[frame] = Math.log1p(lowSum);
    previous.set(current);
  }
  return { full, low };
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
  const minLag = Math.max(1, Math.floor((frameRate * 60) / 240));
  const maxLag = Math.min(centered.length - 2, Math.ceil((frameRate * 60) / 40));
  if (maxLag <= minLag) return 120;

  const scores = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const count = centered.length - lag;
    for (let i = 0; i < count; i++) sum += (centered[i] ?? 0) * (centered[i + lag] ?? 0);
    scores[lag] = sum / count;
  }

  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if ((scores[lag] ?? 0) >= (scores[lag - 1] ?? 0) && (scores[lag] ?? 0) >= (scores[lag + 1] ?? 0) && (scores[lag] ?? 0) > best) {
      best = scores[lag] ?? 0;
      bestLag = lag;
    }
  }
  if (best === -Infinity) {
    for (let lag = minLag; lag <= maxLag; lag++) {
      if ((scores[lag] ?? 0) > best) {
        best = scores[lag] ?? 0;
        bestLag = lag;
      }
    }
  }

  let lag = bestLag;
  for (;;) {
    const half = Math.round(lag / 2);
    if (half < minLag + 1 || half >= lag) break;
    const doubled = 60 / (half / frameRate);
    // Kick on 1 and 3 is a strong half-note pulse. The printed grid is the quarter note,
    // so a shorter lag in the quarter-note range wins when it still carries that pulse.
    // Eighth notes (above ~168) are not a 4/4 beat.
    if (doubled < 80 || doubled > 168) break;
    const peak = (scores[half] ?? 0) >= (scores[half - 1] ?? 0) && (scores[half] ?? 0) >= (scores[Math.min(maxLag, half + 1)] ?? 0);
    if (!peak || (scores[half] ?? 0) < (scores[lag] ?? 0) * 0.5) break;
    lag = half;
  }

  let bpm = 60 / (lag / frameRate);
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;
  return bpm;
}

function demean(values: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < values.length; i++) mean += values[i] ?? 0;
  mean /= Math.max(1, values.length);
  const centered = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) centered[i] = (values[i] ?? 0) - mean;
  return centered;
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
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      const half = length >> 1;
      for (let k = 0; k < half; k++) {
        const evenReal = real[start + k] ?? 0;
        const evenImag = imag[start + k] ?? 0;
        const oddIndex = start + k + half;
        const oddReal = (real[oddIndex] ?? 0) * twiddleReal - (imag[oddIndex] ?? 0) * twiddleImag;
        const oddImag = (real[oddIndex] ?? 0) * twiddleImag + (imag[oddIndex] ?? 0) * twiddleReal;
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
