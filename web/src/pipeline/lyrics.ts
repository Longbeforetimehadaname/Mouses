import type { LyricWord } from "../types";

const WHISPER_RATE = 16000;

type Timestamp = [number, number | null] | { start?: number; end?: number | null };

interface AsrChunk {
  text?: string;
  timestamp?: Timestamp;
}

interface AsrOutput {
  text?: string;
  chunks?: AsrChunk[];
}

interface TranscribeOptions {
  return_timestamps: "word";
  chunk_length_s: number;
  stride_length_s: number;
  num_beams: number;
  task: "transcribe";
  condition_on_prev_tokens: false;
  compression_ratio_threshold: number;
  no_speech_threshold: number;
  temperature: number;
}

interface Transcriber {
  (audio: Float32Array, options: TranscribeOptions): Promise<AsrOutput | AsrOutput[]>;
  dispose?: () => Promise<void>;
}

export async function transcribeVocals(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  onProgress?: (fraction: number) => void,
): Promise<LyricWord[]> {
  const mono = await mixToMono16k(left, right, sampleRate);
  if (mono.length === 0) {
    onProgress?.(1);
    return [];
  }

  // Loaded only after the separation worker has been terminated, so the two
  // WASM heaps are not live together on a phone.
  // @ts-ignore The shell adds this package; see src/pipeline/deps-requested.txt.
  const imported = await import("@huggingface/transformers");
  const transformers = imported as {
    env: { allowLocalModels: boolean };
    pipeline: (
      task: "automatic-speech-recognition",
      model: string,
      options?: {
        device?: "wasm";
        dtype?: "q8";
        progress_callback?: (info: { status?: string; progress?: number }) => void;
      },
    ) => Promise<Transcriber>;
  };
  transformers.env.allowLocalModels = false;
  onProgress?.(0.05);
  let transcriber: Transcriber | null = await transformers.pipeline(
    "automatic-speech-recognition",
    "Xenova/whisper-base",
    {
      // q8 stays inside the phone budget. Base hears sung words that tiny invents.
      device: "wasm",
      dtype: "q8",
      progress_callback: (info) => {
        if (!onProgress || info.status !== "progress" || typeof info.progress !== "number") return;
        onProgress(0.05 + Math.max(0, Math.min(1, info.progress / 100)) * 0.35);
      },
    },
  );
  try {
    onProgress?.(0.45);
    const words = await transcribeChunks(transcriber, peakNormalize(mono), (fraction) => {
      onProgress?.(0.45 + fraction * 0.55);
    });
    onProgress?.(1);
    return words;
  } finally {
    const done = transcriber;
    transcriber = null;
    if (done && typeof done.dispose === "function") {
      try {
        await done.dispose();
      } catch {
        // The words are already copied out; releasing Whisper is best-effort.
      }
    }
  }
}

async function transcribeChunks(
  transcriber: Transcriber,
  mono: Float32Array,
  onProgress: (fraction: number) => void,
): Promise<LyricWord[]> {
  onProgress(0.05);
  const output = await transcriber(mono, {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 2,
    num_beams: 1,
    task: "transcribe",
    condition_on_prev_tokens: false,
    compression_ratio_threshold: 2.4,
    no_speech_threshold: 0.6,
    temperature: 0,
  });
  onProgress(0.9);
  const first = Array.isArray(output) ? output[0] : output;
  const words = chunksToLyricWords(first?.chunks ?? []);
  const kept: LyricWord[] = [];
  for (const word of words) {
    // Drop a word that does not sit on the vocal. That is a guess, not singing.
    if (regionRms(mono, word.start, word.end) < 0.015) continue;
    kept.push(word);
  }
  onProgress(1);
  return kept;
}

function regionRms(mono: Float32Array, startSec: number, endSec: number): number {
  const start = Math.max(0, Math.floor(startSec * WHISPER_RATE));
  const end = Math.min(mono.length, Math.max(start + 1, Math.ceil(endSec * WHISPER_RATE)));
  let energy = 0;
  let count = 0;
  for (let i = start; i < end; i += 4) {
    const sample = mono[i] ?? 0;
    energy += sample * sample;
    count += 1;
  }
  return Math.sqrt(energy / Math.max(1, count));
}

function peakNormalize(mono: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const value = Math.abs(mono[i] ?? 0);
    if (value > peak) peak = value;
  }
  if (peak < 1e-4 || (peak > 0.85 && peak < 1.05)) return mono;
  const gain = 0.9 / peak;
  const scaled = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) scaled[i] = (mono[i] ?? 0) * gain;
  return scaled;
}

export function chunksToLyricWords(chunks: readonly AsrChunk[]): LyricWord[] {
  const words: LyricWord[] = [];
  for (const chunk of chunks) {
    const range = timestampRange(chunk.timestamp);
    if (!range) continue;
    const [start, end] = range;
    const parts = (chunk.text ?? "").trim().split(/\s+/).filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    if (parts.length === 1) {
      const only = parts[0];
      if (only) words.push({ text: only, start, end });
      continue;
    }
    const step = (end - start) / parts.length;
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      if (!text) continue;
      words.push({
        text,
        start: start + i * step,
        end: start + (i + 1) * step,
      });
    }
  }
  return words;
}

function timestampRange(timestamp: Timestamp | undefined): [number, number] | null {
  if (!timestamp) return null;
  if (Array.isArray(timestamp)) {
    if (typeof timestamp[0] !== "number") return null;
    const end = typeof timestamp[1] === "number" ? timestamp[1] : timestamp[0];
    return ordered(timestamp[0], end);
  }
  if (typeof timestamp.start !== "number") return null;
  const end = typeof timestamp.end === "number" ? timestamp.end : timestamp.start;
  return ordered(timestamp.start, end);
}

function ordered(start: number, end: number): [number, number] {
  return end < start ? [end, start] : [start, end];
}

async function mixToMono16k(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): Promise<Float32Array> {
  const length = Math.max(left.length, right.length);
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const l = i < left.length ? left[i] ?? 0 : 0;
    const r = i < right.length ? right[i] ?? 0 : 0;
    mono[i] = 0.5 * (l + r);
  }
  if (length === 0 || sampleRate === WHISPER_RATE) return mono;
  if (sampleRate <= 0) throw new Error("Vocal sample rate is invalid");
  const outLength = Math.max(1, Math.round(length * WHISPER_RATE / sampleRate));
  const offline = new OfflineAudioContext(1, outLength, WHISPER_RATE);
  const buffer = offline.createBuffer(1, length, sampleRate);
  buffer.copyToChannel(mono, 0);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}
