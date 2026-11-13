import type { ChordChange, SplitMp3, WordLyric } from "../contract";
import { detectChords } from "../../web/src/pipeline/chords";
import { transcribeVocals } from "../../web/src/pipeline/lyrics";
import { separate } from "../../web/src/pipeline/separate";

const MODEL_RATE = 44100;

// Shell entry. Separation, lyrics, and chords stay in web/src/pipeline.
export const splitMp3: SplitMp3 = async (file, onProgress) => {
  onProgress({ stage: "Reading audio", fraction: 0.02 });
  if (file.byteLength === 0) throw new Error("That MP3 is empty.");
  const decoded = await decodeToStereo44100(file);
  onProgress({ stage: "Reading audio", fraction: 0.08 });

  const separated = await separate(decoded, (fraction) => {
    const clamped = Math.max(0, Math.min(1, fraction));
    onProgress({ stage: "Separating instruments", fraction: 0.08 + clamped * 0.64 });
  });

  onProgress({ stage: "Reading lyrics", fraction: 0.74 });
  const recognized = await transcribeVocals(
    separated.vocals.left,
    separated.vocals.right,
    MODEL_RATE,
    (fraction) => {
      onProgress({ stage: "Reading lyrics", fraction: 0.74 + Math.max(0, Math.min(1, fraction)) * 0.16 });
    },
  );
  const lyrics = toWordLyrics(recognized);
  onProgress({ stage: "Reading lyrics", fraction: 0.9 });

  onProgress({ stage: "Finding chords", fraction: 0.92 });
  const harmonic = harmonicMix(separated);
  const found = detectChords(
    decoded.left,
    decoded.right,
    MODEL_RATE,
    separated.bass.left,
    separated.bass.right,
    harmonic.left,
    harmonic.right,
  );
  const chords = chordChanges(found.beats);
  const durationSec = decoded.left.length / MODEL_RATE;
  onProgress({ stage: "Ready", fraction: 1 });

  return {
    stems: {
      drums: toBuffer(separated.drums.left, separated.drums.right),
      vocals: toBuffer(separated.vocals.left, separated.vocals.right),
      bass: toBuffer(separated.bass.left, separated.bass.right),
      guitar: toBuffer(separated.guitar.left, separated.guitar.right),
      rest: toBuffer(separated.rest.left, separated.rest.right),
    },
    durationSec,
    bpm: found.bpm,
    lyrics,
    chords,
  };
};

function toWordLyrics(words: readonly { text: string; start: number }[]): WordLyric[] {
  const lyrics: WordLyric[] = [];
  for (const word of words) {
    const text = word.text.trim();
    if (!text || !Number.isFinite(word.start)) continue;
    lyrics.push({ word: text, timeSec: Math.max(0, word.start) });
  }
  return lyrics;
}

function chordChanges(
  beats: readonly { bar: number; beat: number; chord: string | null; time: number }[],
): ChordChange[] {
  const changes: ChordChange[] = [];
  let previousBeat = -1;
  for (const beat of beats) {
    if (!beat.chord) continue;
    const index = beat.bar * 4 + beat.beat;
    if (index === previousBeat) continue;
    const last = changes[changes.length - 1];
    if (last && last.name === beat.chord) continue;
    changes.push({
      beat: index,
      name: beat.chord,
      timeSec: Number.isFinite(beat.time) ? beat.time : 0,
    });
    previousBeat = index;
  }
  return changes;
}

function harmonicMix(separated: {
  bass: { left: Float32Array; right: Float32Array };
  guitar: { left: Float32Array; right: Float32Array };
  rest: { left: Float32Array; right: Float32Array };
}): { left: Float32Array; right: Float32Array } {
  const length = Math.max(
    separated.bass.left.length,
    separated.guitar.left.length,
    separated.rest.left.length,
  );
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  addInto(left, separated.bass.left, 1.4);
  addInto(right, separated.bass.right, 1.4);
  addInto(left, separated.guitar.left, 1);
  addInto(right, separated.guitar.right, 1);
  addInto(left, separated.rest.left, 0.6);
  addInto(right, separated.rest.right, 0.6);
  return { left, right };
}

function addInto(destination: Float32Array, source: Float32Array, gain: number): void {
  const length = Math.min(destination.length, source.length);
  for (let i = 0; i < length; i++) destination[i] = (destination[i] ?? 0) + (source[i] ?? 0) * gain;
}

async function decodeToStereo44100(file: ArrayBuffer): Promise<{ left: Float32Array; right: Float32Array }> {
  const context = await openAudioContext();
  try {
    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(file.slice(0));
    } catch {
      throw new Error("Could not read that MP3.");
    }
    if (decoded.length === 0) throw new Error("That MP3 is empty.");
    const left = new Float32Array(decoded.getChannelData(0));
    const rightChannel = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0);
    const right = new Float32Array(rightChannel);
    if (decoded.sampleRate === MODEL_RATE) return { left, right };
    return resampleStereo(left, right, decoded.sampleRate, MODEL_RATE);
  } finally {
    await context.close();
  }
}

async function openAudioContext(): Promise<AudioContext> {
  const Ctor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("This browser cannot decode MP3 audio.");
  try {
    return new Ctor({ sampleRate: MODEL_RATE });
  } catch {
    return new Ctor();
  }
}

async function resampleStereo(
  left: Float32Array,
  right: Float32Array,
  fromRate: number,
  toRate: number,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const length = Math.max(left.length, right.length);
  const outLength = Math.max(1, Math.round((length * toRate) / fromRate));
  const offline = new OfflineAudioContext(2, outLength, toRate);
  const buffer = offline.createBuffer(2, length, fromRate);
  buffer.copyToChannel(fit(left, length), 0);
  buffer.copyToChannel(fit(right, length), 1);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return {
    left: new Float32Array(rendered.getChannelData(0)),
    right: new Float32Array(rendered.getChannelData(1)),
  };
}

function toBuffer(left: Float32Array, right: Float32Array): AudioBuffer {
  const length = Math.max(left.length, right.length);
  if (length === 0) {
    return new AudioBuffer({ length: 1, numberOfChannels: 2, sampleRate: MODEL_RATE });
  }
  const buffer = new AudioBuffer({ length, numberOfChannels: 2, sampleRate: MODEL_RATE });
  buffer.copyToChannel(fit(left, length), 0);
  buffer.copyToChannel(fit(right, length), 1);
  return buffer;
}

function fit(channel: Float32Array, length: number): Float32Array<ArrayBuffer> {
  const fitted = new Float32Array(length);
  fitted.set(channel.subarray(0, Math.min(channel.length, length)));
  return fitted;
}
