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

interface Transcriber {
  (audio: Float32Array, options: { return_timestamps: "word" }): Promise<AsrOutput | AsrOutput[]>;
  dispose?: () => Promise<void>;
}

export async function transcribeVocals(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): Promise<LyricWord[]> {
  const mono = await mixToMono16k(left, right, sampleRate);
  if (mono.length === 0) return [];

  // Loaded only after the Demucs worker has been terminated.
  const transformers = await import("@huggingface/transformers") as {
    env: { allowLocalModels: boolean };
    pipeline: (task: "automatic-speech-recognition", model: string) => Promise<Transcriber>;
  };
  transformers.env.allowLocalModels = false;
  let transcriber: Transcriber | null = await transformers.pipeline(
    "automatic-speech-recognition",
    "Xenova/whisper-tiny",
  );
  try {
    const output = await transcriber(mono, { return_timestamps: "word" });
    const first = Array.isArray(output) ? output[0] : output;
    return chunksToLyricWords(first?.chunks ?? []);
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

export function chunksToLyricWords(chunks: readonly AsrChunk[]): LyricWord[] {
  const words: LyricWord[] = [];
  for (const chunk of chunks) {
    const range = timestampRange(chunk.timestamp);
    if (!range) continue;
    const [start, end] = range;
    const parts = (chunk.text ?? "").trim().split(/\s+/).filter((part) => part.length > 0);
    if (parts.length === 0) continue;
    if (parts.length === 1) {
      words.push({ text: parts[0], start, end });
      continue;
    }
    const step = (end - start) / parts.length;
    for (let i = 0; i < parts.length; i++) {
      words.push({
        text: parts[i],
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
    const l = i < left.length ? left[i] : 0;
    const r = i < right.length ? right[i] : 0;
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
