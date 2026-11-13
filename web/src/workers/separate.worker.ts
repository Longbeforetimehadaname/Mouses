// @ts-nocheck — onnxruntime tensors are dense; the shell's indexed-access check does not model that.
import * as ort from "onnxruntime-web";
import { fastSeparate } from "../pipeline/fast-separate";

// Safari cannot spawn the nested workers that threaded WASM and ORT's proxy
// worker would start. One thread, in this module worker, is the whole runtime.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
// Must match the shell lockfile (onnxruntime-web 1.31.1).
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";

// Deezer Spleeter 4-stem U-Nets, fp16 weights, public ONNX export.
// Order is the index fastSeparate passes to runStem: vocals, drums, bass, other.
const MODEL_BASE = "https://huggingface.co/Best-Practice/spleeter-4stems-onnx/resolve/main/";
const MODEL_NAMES = ["vocals", "drums", "bass", "other"];

const scope = globalThis;
let queue = Promise.resolve();

scope.onmessage = (event) => {
  const message = event.data;
  queue = queue.then(() => dispatch(message)).catch((error) => {
    scope.postMessage({ type: "error", message: errorText(error) });
  });
};

async function dispatch(message) {
  if (!message || message.type !== "separate") {
    throw new Error("Stem separation worker received an unknown message");
  }
  const sessions = await loadSessions((fraction) => {
    scope.postMessage({ type: "progress", fraction: fraction * 0.12 });
  });
  try {
    const stems = await fastSeparate(message.left, message.right, (stem, magnitudes) => {
      return runSession(sessions[stem], magnitudes);
    }, (fraction) => {
      scope.postMessage({ type: "progress", fraction: 0.12 + fraction * 0.88 });
    });
    const transfer = [];
    for (const id of ["drums", "vocals", "bass", "guitar", "rest"]) {
      transfer.push(stems[id].left.buffer, stems[id].right.buffer);
    }
    scope.postMessage({ type: "done", stems }, transfer);
  } finally {
    await Promise.all(sessions.map((session) => release(session)));
  }
}

async function loadSessions(onFraction) {
  const sessions = [];
  for (let index = 0; index < MODEL_NAMES.length; index++) {
    const name = MODEL_NAMES[index];
    const bytes = await loadModel(`${MODEL_BASE}${name}.fp16.onnx`, (fraction) => {
      onFraction((index + fraction) / MODEL_NAMES.length);
    });
    sessions.push(await createSession(bytes));
  }
  return sessions;
}

async function createSession(bytes) {
  const attempts = [
    { graphOptimizationLevel: "all", enableMemPattern: true, enableCpuMemArena: false },
    { graphOptimizationLevel: "disabled", enableMemPattern: false, enableCpuMemArena: false },
  ];
  let last = new Error("Could not start the stem model");
  for (const extra of attempts) {
    try {
      return await ort.InferenceSession.create(bytes, {
        executionProviders: ["wasm"],
        executionMode: "sequential",
        ...extra,
      });
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw last;
}

async function runSession(session, magnitudes) {
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor("float32", magnitudes, [2, 1, 512, 1024]);
  const outputs = await session.run({ [inputName]: tensor });
  return copyFloat32(outputs[outputName].data);
}

function copyFloat32(data) {
  if (data instanceof Float32Array) return new Float32Array(data);
  const copy = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) copy[i] = Number(data[i]);
  return copy;
}

async function loadModel(url, onFraction) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      onFraction(1);
      return hit.arrayBuffer();
    }
  }
  const bytes = await downloadModel(url, onFraction);
  if (cache) {
    try {
      await cache.put(url, new Response(bytes.slice(0)));
    } catch {
      // A private window can refuse the cache. The bytes are already in hand.
    }
  }
  return bytes;
}

async function openCache() {
  try {
    if (typeof caches === "undefined") return null;
    return await caches.open("mouses-spleeter-v1");
  } catch {
    return null;
  }
}

async function downloadModel(url, onFraction) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Stem model download failed (${response.status})`);
  const total = Number(response.headers.get("Content-Length") ?? "0");
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    onFraction(1);
    return buffer;
  }
  const reader = body.getReader();
  const parts = [];
  let received = 0;
  let marked = -1;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    if (!step.value) continue;
    parts.push(step.value);
    received += step.value.byteLength;
    const fraction = total > 0 ? Math.min(1, received / total) : 0;
    const bucket = Math.floor(fraction * 20);
    if (bucket !== marked) {
      marked = bucket;
      onFraction(fraction);
    }
  }
  onFraction(1);
  if (received === 0) throw new Error("Stem model download was empty");
  const packed = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    packed.set(part, offset);
    offset += part.byteLength;
  }
  return packed.buffer;
}

async function release(session) {
  try {
    if (session && typeof session.release === "function") await session.release();
  } catch {
    // The stems are already copied out.
  }
}

function errorText(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
