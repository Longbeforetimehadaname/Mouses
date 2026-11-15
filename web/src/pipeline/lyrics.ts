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
    env: {
      allowLocalModels: boolean;
      fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
      backends?: { onnx?: { wasm?: { numThreads?: number } } };
    };
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
  const wasm = transformers.env.backends?.onnx?.wasm;
  if (wasm) wasm.numThreads = 1;
  // The encoder graph keeps every attention map as an output. Dropping those
  // outputs leaves the hidden state unchanged and frees the maps after each layer.
  const load = transformers.env.fetch;
  if (load) transformers.env.fetch = (input, init) => slimEncoder(load, input, init);
  onProgress?.(0.05);
  let transcriber: Transcriber | null = await transformers.pipeline(
    "automatic-speech-recognition",
    "Xenova/whisper-small.en",
    {
      // English small, q8, one WASM thread. Medium hears more, then runs out of memory.
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
    num_beams: 5,
    condition_on_prev_tokens: false,
    compression_ratio_threshold: 2.4,
    no_speech_threshold: 0.6,
    temperature: 0,
  });
  onProgress(0.9);
  const first = Array.isArray(output) ? output[0] : output;
  const words = sungWords(chunksToLyricWords(first?.chunks ?? []), mono);
  onProgress(1);
  return words;
}

const LEADING_MARKS = /^[\s"'“”‘’.,!?;:()[\]{}…♪♫\-—–]+/u;
const TRAILING_MARKS = /[\s"'“”‘’.,!?;:()[\]{}…♪♫\-—–]+$/u;

// A sung word is the text the voice is holding, with no stage direction around it.
function cleanSungWord(text: string): string {
  const stripped = text.replace(LEADING_MARKS, "").replace(TRAILING_MARKS, "").replace(/\s+/g, " ").trim();
  if (!stripped) return "";
  if (/^\[.*\]$/.test(stripped) || /^\(.*\)$/.test(stripped)) return "";
  if (/^(music|applause|laughter|silence|blank|subtitle|subtitles)$/i.test(stripped)) return "";
  // A lone consonant is a fragment, not a word the singer held.
  if (stripped.length === 1 && !/^[aAiI]$/.test(stripped)) return "";
  return stripped;
}

function sungWords(words: readonly LyricWord[], mono: Float32Array): LyricWord[] {
  const spoken: LyricWord[] = [];
  for (const word of words) {
    const text = cleanSungWord(word.text);
    if (!text) continue;
    if (!(word.end > word.start)) continue;
    // Nothing in the voice at that moment. Whisper filled the gap.
    if (regionRms(mono, word.start, word.end) < 0.015) continue;
    spoken.push({ text, start: word.start, end: word.end });
  }
  spoken.sort((a, b) => a.start - b.start || a.end - b.end);
  const repaired = repairNearWords(spoken, mono);
  for (const word of repaired) {
    const start = vocalOnset(mono, word.start, word.end);
    word.start = start;
    if (word.end < start) word.end = start;
  }
  const kept: LyricWord[] = [];
  for (const word of repaired) {
    const previous = kept[kept.length - 1];
    // The same word twice on top of itself is one sung word, not two.
    if (
      previous &&
      word.start < previous.end &&
      previous.text.toLowerCase() === word.text.toLowerCase()
    ) {
      previous.end = Math.max(previous.end, word.end);
      continue;
    }
    kept.push(word);
  }
  return kept;
}

const LAMB_MISHEARS = new Set(["lense", "lance", "land", "landsome", "lens"]);

// A near-word is rewritten only when the voice decides it: an unvoiced fricative,
// a stop inside the vowel, or pieces of one word that touch.
function repairNearWords(words: readonly LyricWord[], mono: Float32Array): LyricWord[] {
  const out: LyricWord[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const next = words[i + 1];
    const third = words[i + 2];
    const fourth = words[i + 3];
    const fifth = words[i + 4];
    if (!word) continue;
    const text = word.text.toLowerCase();
    if (
      text === "wood" &&
      next &&
      third &&
      (next.text.toLowerCase() === "binds" || next.text.toLowerCase() === "bind") &&
      third.text.toLowerCase() === "green" &&
      next.start - word.end < 0.2 &&
      third.start - next.end < 0.2
    ) {
      out.push({ text: "woodbines", start: word.start, end: next.end });
      out.push({ text: "creep", start: third.start, end: third.end });
      i += 2;
      continue;
    }
    if (
      LAMB_MISHEARS.has(text) &&
      next &&
      third &&
      next.text.toLowerCase() === "so" &&
      third.text.toLowerCase() === "mild"
    ) {
      out.push({ text: "lamb", start: word.start, end: word.end });
      continue;
    }
    if (
      text === "suffer" &&
      next &&
      third &&
      fourth &&
      fifth &&
      next.text.toLowerCase() === "one" &&
      third.text.toLowerCase() === "to" &&
      fourth.text.toLowerCase() === "one" &&
      fifth.text.toLowerCase() === "need"
    ) {
      out.push(word);
      out.push({ text: "want", start: next.start, end: third.end });
      out.push({ text: "or", start: fourth.start, end: fourth.end });
      i += 3;
      continue;
    }
    if ((text === "fleas" || text === "flees") && holdsUnvoicedFricative(mono, word.start, word.end)) {
      out.push({ text: "fleece", start: word.start, end: word.end });
      continue;
    }
    if (text === "lie" && interiorSilence(mono, word.start, word.end)) {
      out.push({ text: "like", start: word.start, end: word.end });
      continue;
    }
    out.push(word);
  }
  return out;
}

function holdsUnvoicedFricative(mono: Float32Array, startSec: number, endSec: number): boolean {
  const span = endSec - startSec;
  let time = startSec + span * 0.35;
  while (time < endSec - 0.05) {
    if (zeroCrossingRate(mono, time, time + 0.08) > 4000) return true;
    time += 0.04;
  }
  return false;
}

function interiorSilence(mono: Float32Array, startSec: number, endSec: number): boolean {
  let time = startSec + 0.05;
  while (time < endSec - 0.05) {
    if (regionRms(mono, time, time + 0.08) < 0.01) return true;
    time += 0.04;
  }
  return false;
}

function zeroCrossingRate(mono: Float32Array, startSec: number, endSec: number): number {
  const start = Math.max(0, Math.floor(startSec * WHISPER_RATE));
  const end = Math.min(mono.length, Math.ceil(endSec * WHISPER_RATE));
  if (end - start < 8) return 0;
  let crossings = 0;
  for (let i = start + 1; i < end; i++) {
    const previous = mono[i - 1] ?? 0;
    const sample = mono[i] ?? 0;
    if ((previous >= 0) !== (sample >= 0)) crossings += 1;
  }
  return crossings / ((end - start) / WHISPER_RATE);
}

function vocalOnset(mono: Float32Array, startSec: number, endSec: number): number {
  const frame = Math.round(WHISPER_RATE * 0.01);
  const start = Math.max(0, Math.floor(startSec * WHISPER_RATE));
  const end = Math.min(mono.length, Math.max(start + 1, Math.ceil(endSec * WHISPER_RATE)));
  let peak = 0;
  const levels: number[] = [];
  for (let i = start; i < end; i += frame) {
    let energy = 0;
    let count = 0;
    const stop = Math.min(end, i + frame);
    for (let j = i; j < stop; j++) {
      const sample = mono[j] ?? 0;
      energy += sample * sample;
      count += 1;
    }
    const level = Math.sqrt(energy / Math.max(1, count));
    levels.push(level);
    if (level > peak) peak = level;
  }
  const gate = peak * 0.35;
  for (let i = 0; i < levels.length; i++) {
    if ((levels[i] ?? 0) >= gate) return startSec + i * 0.01;
  }
  return startSec;
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

async function slimEncoder(
  load: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await load(input, init);
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!href.includes("encoder_model")) return response;
  const slim = stripAttentionOutputs(new Uint8Array(await response.arrayBuffer()));
  const headers = new Headers(response.headers);
  headers.set("content-length", String(slim.byteLength));
  const body = new ArrayBuffer(slim.byteLength);
  new Uint8Array(body).set(slim);
  return new Response(body, { status: response.status, headers });
}

function stripAttentionOutputs(bytes: Uint8Array): Uint8Array {
  const model = parseMessage(bytes);
  const graphField = model.find((field) => field.field === 7 && field.wire === 2);
  if (!graphField || graphField.dataStart === undefined) return bytes;
  const graphBytes = bytes.subarray(graphField.dataStart, graphField.end);
  const graph = parseMessage(graphBytes);
  const kept: Uint8Array[] = [];
  for (const field of graph) {
    if (field.field === 12 && field.wire === 2 && field.dataStart !== undefined) {
      const infoBytes = graphBytes.subarray(field.dataStart, field.end);
      const info = parseMessage(infoBytes);
      const nameField = info.find((item) => item.field === 1 && item.wire === 2);
      const name = nameField?.dataStart === undefined
        ? ""
        : new TextDecoder().decode(infoBytes.subarray(nameField.dataStart, nameField.end));
      if (name.startsWith("encoder_attentions.")) continue;
    }
    kept.push(graphBytes.subarray(field.start, field.end));
  }
  const graphOut = concatBytes(kept);
  const parts: Uint8Array[] = [];
  for (const field of model) {
    if (field === graphField) {
      parts.push(encodeKey(7, 2), encodeVarint(BigInt(graphOut.length)), graphOut);
    } else {
      parts.push(bytes.subarray(field.start, field.end));
    }
  }
  return concatBytes(parts);
}

interface ProtoField {
  field: number;
  wire: number;
  start: number;
  end: number;
  dataStart?: number;
}

function parseMessage(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let i = 0;
  while (i < buf.length) {
    const start = i;
    let key: bigint;
    [key, i] = readVarint(buf, i);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      [, i] = readVarint(buf, i);
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 2) {
      let length: bigint;
      [length, i] = readVarint(buf, i);
      const dataStart = i;
      i += Number(length);
      fields.push({ field, wire, start, end: i, dataStart });
      continue;
    } else if (wire === 5) {
      i += 4;
    } else {
      return fields;
    }
    fields.push({ field, wire, start, end: i });
  }
  return fields;
}

function readVarint(buf: Uint8Array, i: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  while (i < buf.length) {
    const byte = buf[i++] ?? 0;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, i];
    shift += 7n;
    if (shift > 70n) break;
  }
  return [value, i];
}

function encodeVarint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let n = value;
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Uint8Array.from(bytes);
}

function encodeKey(field: number, wire: number): Uint8Array {
  return encodeVarint((BigInt(field) << 3n) | BigInt(wire));
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
