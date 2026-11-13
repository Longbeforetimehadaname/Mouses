import { STEM_IDS, type StemId } from "../types";

// StemSplit/demucs-onnx's resolve URL for this file answers 401.
// StemSplitio publishes the 6-stem fp16 weights (input `mix` [1, 2, 343980]).
const DEMUCS_MODEL_URL =
  "https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx";

const SEGMENT_SAMPLES = 343980;

/** htdemucs_6s source axis: drums, bass, other, vocals, guitar, piano. */
const SOURCE_STEM: StemId[] = ["drums", "bass", "rest", "vocals", "guitar", "rest"];

export interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

type SegmentResult = { id: number; data: Float32Array; dims: number[] };

type WorkerOutbound =
  | { type: "download"; fraction: number }
  | { type: "ready" }
  | { type: "segment"; id: number; data: Float32Array; dims: number[] }
  | { type: "error"; message: string };

export async function separate(
  audio: { left: Float32Array; right: Float32Array },
  onProgress: (p: number) => void,
): Promise<Record<StemId, Stereo>> {
  const length = Math.max(audio.left.length, audio.right.length);
  if (length === 0) return emptyStems(0);

  const worker = new Worker(new URL("../workers/demucs.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await separateInWorker(worker, audio, length, onProgress);
  } finally {
    worker.terminate();
  }
}

async function separateInWorker(
  worker: Worker,
  audio: { left: Float32Array; right: Float32Array },
  length: number,
  onProgress: (p: number) => void,
): Promise<Record<StemId, Stereo>> {
  let downloadSeen = false;
  const pending = new Map<number, {
    resolve: (result: SegmentResult) => void;
    reject: (error: Error) => void;
  }>();
  let ready: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let failed: Error | null = null;

  const fail = (error: Error) => {
    if (!failed) failed = error;
    ready?.reject(error);
    ready = null;
    for (const wait of pending.values()) wait.reject(error);
    pending.clear();
  };

  worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "error") {
      fail(new Error(message.message || "Demucs worker failed"));
      return;
    }
    if (message.type === "download") {
      downloadSeen = true;
      onProgress(Math.max(0, Math.min(1, message.fraction)) * 0.2);
      return;
    }
    if (message.type === "ready") {
      ready?.resolve();
      ready = null;
      return;
    }
    if (message.type === "segment") {
      const wait = pending.get(message.id);
      if (!wait) return;
      pending.delete(message.id);
      wait.resolve({ id: message.id, data: message.data, dims: message.dims });
    }
  };
  worker.onerror = (event) => {
    fail(new Error(event.message || "Demucs worker failed"));
  };
  worker.onmessageerror = () => {
    fail(new Error("Demucs worker message could not be deserialized"));
  };

  const loaded = new Promise<void>((resolve, reject) => {
    ready = { resolve, reject };
  });
  worker.postMessage({ type: "load", modelUrl: DEMUCS_MODEL_URL });
  await loaded;
  if (!downloadSeen) onProgress(0.2);

  const hop = Math.round(SEGMENT_SAMPLES * 0.75);
  const window = triangularWindow(SEGMENT_SAMPLES);
  const weight = new Float32Array(length);
  const stems = emptyStems(length);
  const starts = segmentStarts(length, hop);
  let nextId = 0;

  for (let index = 0; index < starts.length; index++) {
    if (failed) throw failed;
    const start = starts[index];
    const end = Math.min(start + SEGMENT_SAMPLES, length);
    const count = end - start;
    const mix = new Float32Array(SEGMENT_SAMPLES * 2);
    copyChannel(audio.left, mix, 0, start, count);
    copyChannel(audio.right, mix, SEGMENT_SAMPLES, start, count);
    const output = await requestSegment(worker, pending, nextId, mix);
    nextId += 1;
    const sources = readDemucsSources(output.data, output.dims);
    addChunk(stems, sources, window, weight, start, count);
    onProgress(0.2 + 0.8 * ((index + 1) / starts.length));
  }

  normalizeStems(stems, weight);
  return stems;
}

function requestSegment(
  worker: Worker,
  pending: Map<number, { resolve: (result: SegmentResult) => void; reject: (error: Error) => void }>,
  id: number,
  mix: Float32Array,
): Promise<SegmentResult> {
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: "segment", id, mix }, [mix.buffer]);
  });
}

function segmentStarts(length: number, hop: number): number[] {
  const starts: number[] = [];
  if (length <= 0) return [0];
  for (let start = 0; start < length; start += hop) {
    starts.push(start);
    if (start + SEGMENT_SAMPLES >= length) break;
  }
  return starts;
}

function emptyStems(length: number): Record<StemId, Stereo> {
  const stems = {} as Record<StemId, Stereo>;
  for (const id of STEM_IDS) {
    stems[id] = { left: new Float32Array(length), right: new Float32Array(length) };
  }
  return stems;
}

function copyChannel(
  source: Float32Array,
  mix: Float32Array,
  mixOffset: number,
  start: number,
  count: number,
): void {
  const available = Math.max(0, Math.min(count, source.length - start));
  if (available <= 0) return;
  mix.set(source.subarray(start, start + available), mixOffset);
}

export function triangularWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  if (length === 0) return window;
  if (length === 1) {
    window[0] = 1;
    return window;
  }
  const half = (length - 1) / 2;
  for (let i = 0; i < length; i++) {
    window[i] = 1 - Math.abs(i - half) / half;
  }
  // A triangle is 0 at the endpoints. Normalization would mute those samples.
  window[0] = window[1];
  window[length - 1] = window[length - 2];
  return window;
}

export function readDemucsSources(
  data: Float32Array,
  dims: readonly number[],
): Stereo[] {
  if (dims.length === 0) throw new Error("Demucs output is missing a shape");
  const strides = new Array<number>(dims.length);
  strides[dims.length - 1] = 1;
  for (let axis = dims.length - 2; axis >= 0; axis--) {
    strides[axis] = strides[axis + 1] * dims[axis + 1];
  }
  const sourceAxis = dims.indexOf(6);
  if (sourceAxis < 0) {
    throw new Error(`Demucs output has no 6-stem axis (${dims.join("x")})`);
  }
  let channelAxis = -1;
  let timeAxis = -1;
  for (let axis = 0; axis < dims.length; axis++) {
    if (axis === sourceAxis) continue;
    if (dims[axis] === 2 && channelAxis < 0) channelAxis = axis;
    else if (timeAxis < 0 || dims[axis] > dims[timeAxis]) timeAxis = axis;
  }
  if (channelAxis < 0 || timeAxis < 0) {
    throw new Error(`Demucs output shape ${dims.join("x")} has no stereo time axis`);
  }
  const samples = dims[timeAxis];
  const timeStride = strides[timeAxis];
  const sources: Stereo[] = [];
  for (let source = 0; source < 6; source++) {
    const left = new Float32Array(samples);
    const right = new Float32Array(samples);
    const leftBase = source * strides[sourceAxis];
    const rightBase = leftBase + strides[channelAxis];
    if (timeStride === 1) {
      left.set(data.subarray(leftBase, leftBase + samples));
      right.set(data.subarray(rightBase, rightBase + samples));
    } else {
      for (let time = 0; time < samples; time++) {
        left[time] = data[leftBase + time * timeStride];
        right[time] = data[rightBase + time * timeStride];
      }
    }
    sources.push({ left, right });
  }
  return sources;
}

function addChunk(
  stems: Record<StemId, Stereo>,
  sources: Stereo[],
  window: Float32Array,
  weight: Float32Array,
  offset: number,
  count: number,
): void {
  const usable = Math.min(count, window.length);
  for (let source = 0; source < sources.length && source < SOURCE_STEM.length; source++) {
    const stem = SOURCE_STEM[source];
    const channel = sources[source];
    const length = Math.min(usable, channel.left.length, channel.right.length);
    addWindowed(stems[stem].left, channel.left, window, offset, length);
    addWindowed(stems[stem].right, channel.right, window, offset, length);
  }
  const weightLength = Math.min(usable, Math.max(0, weight.length - offset));
  for (let i = 0; i < weightLength; i++) weight[offset + i] += window[i];
}

function addWindowed(
  destination: Float32Array,
  source: Float32Array,
  window: Float32Array,
  offset: number,
  length: number,
): void {
  const end = Math.min(length, destination.length - offset, source.length, window.length);
  for (let i = 0; i < end; i++) destination[offset + i] += source[i] * window[i];
}

function normalizeStems(stems: Record<StemId, Stereo>, weight: Float32Array): void {
  for (const id of STEM_IDS) {
    normalizeChannel(stems[id].left, weight);
    normalizeChannel(stems[id].right, weight);
  }
}

function normalizeChannel(channel: Float32Array, weight: Float32Array): void {
  const length = Math.min(channel.length, weight.length);
  for (let i = 0; i < length; i++) {
    const scale = weight[i];
    if (scale > 1e-8) channel[i] /= scale;
  }
}
