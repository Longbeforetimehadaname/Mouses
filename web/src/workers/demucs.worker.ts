import * as ort from "onnxruntime-web";

// Safari cannot spawn the nested workers that threaded WASM and ORT's proxy
// worker would start. One thread, in this module worker, is the whole runtime.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
// Must match the shell lockfile (onnxruntime-web 1.31.1). The 1.31 build
// loads ort-wasm-simd-threaded.jsep.wasm; a 1.21 wasm file will not start.
ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";

const SEGMENT_SAMPLES = 343980;

interface WorkerScope {
  onmessage: ((this: WorkerScope, event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

type LoadMessage = { type: "load"; modelUrl: string };
type SegmentMessage = { type: "segment"; id: number; mix: Float32Array };
type Inbound = LoadMessage | SegmentMessage;

let session: ort.InferenceSession | null = null;
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event: MessageEvent<Inbound>) => {
  const message = event.data;
  queue = queue.then(() => dispatch(message)).catch((error: unknown) => {
    scope.postMessage({ type: "error", message: errorText(error) });
  });
};

async function dispatch(message: Inbound): Promise<void> {
  if (message.type === "load") {
    await loadModel(message.modelUrl);
    return;
  }
  await runSegment(message);
}

async function loadModel(modelUrl: string): Promise<void> {
  const bytes = await downloadModel(modelUrl, (fraction) => {
    scope.postMessage({ type: "download", fraction });
  });
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ["wasm"],
    // "all" materializes the HTDemucs graph in one pass and the wasm heap
    // throws std::bad_alloc before the first segment can run. Disabled still
    // executes the 1.31.1 wasm session; it just skips that planning copy.
    graphOptimizationLevel: "disabled",
    enableMemPattern: false,
    executionMode: "sequential",
    // Off, so terminating the worker can release the session heap before lyrics load.
    enableCpuMemArena: false,
  };
  session = await ort.InferenceSession.create(bytes, options);
  scope.postMessage({ type: "ready" });
}

async function runSegment(message: SegmentMessage): Promise<void> {
  if (!session) throw new Error("Demucs session is not loaded");
  if (message.mix.length !== SEGMENT_SAMPLES * 2) {
    throw new Error(`Demucs expects ${SEGMENT_SAMPLES} stereo samples, got ${message.mix.length / 2}`);
  }
  const input = new ort.Tensor("float32", message.mix, [1, 2, SEGMENT_SAMPLES]);
  const outputs = await session.run({ mix: input });
  const output = selectOutput(outputs, session.outputNames);
  const dims = output.dims.map((dim) => Number(dim));
  const data = copyFloat32(output.data);
  scope.postMessage({ type: "segment", id: message.id, data, dims }, [data.buffer]);
}

function selectOutput(
  outputs: ort.InferenceSession.ReturnType,
  names: readonly string[],
): ort.Tensor {
  const tensors: ort.Tensor[] = [];
  for (const name of names) {
    const tensor = outputs[name];
    if (tensor) tensors.push(tensor);
  }
  if (tensors.length === 0) {
    for (const tensor of Object.values(outputs)) {
      if (tensor) tensors.push(tensor);
    }
  }
  const six = tensors.find((tensor) => tensor.dims.some((dim) => Number(dim) === 6));
  const chosen = six ?? tensors[0];
  if (!chosen) throw new Error("Demucs session returned no outputs");
  return chosen;
}

function copyFloat32(data: ort.Tensor["data"]): Float32Array {
  if (data instanceof Float32Array) return new Float32Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView & ArrayLike<number>;
    const copy = new Float32Array(view.length);
    for (let i = 0; i < view.length; i++) copy[i] = Number(view[i]);
    return copy;
  }
  if (Array.isArray(data)) return Float32Array.from(data);
  throw new Error("Demucs output is not numeric");
}

async function downloadModel(
  url: string,
  onFraction: (fraction: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Demucs model download failed (${response.status} ${url})`);
  }
  const total = Number(response.headers.get("Content-Length") ?? "0");
  const body = response.body;
  if (!body) {
    const buffer = await response.arrayBuffer();
    onFraction(1);
    return buffer;
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
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
  if (received === 0) throw new Error("Demucs model download was empty");
  const packed = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    packed.set(part, offset);
    offset += part.byteLength;
  }
  return packed.buffer;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
