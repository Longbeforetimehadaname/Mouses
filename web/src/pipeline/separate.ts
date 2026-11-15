import { STEM_IDS, type StemId } from "../types";

export interface Stereo {
  left: Float32Array;
  right: Float32Array;
}

type WorkerOutbound =
  | { type: "progress"; fraction: number }
  | { type: "done"; stems: Record<StemId, Stereo> }
  | { type: "error"; message: string };

export async function separate(
  audio: { left: Float32Array; right: Float32Array },
  onProgress: (fraction: number) => void,
): Promise<Record<StemId, Stereo>> {
  const length = Math.max(audio.left.length, audio.right.length);
  if (length === 0) return emptyStems(0);

  const worker = new Worker(new URL("../workers/separate.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await separateInWorker(worker, audio, onProgress);
  } finally {
    worker.terminate();
  }
}

async function separateInWorker(
  worker: Worker,
  audio: { left: Float32Array; right: Float32Array },
  onProgress: (fraction: number) => void,
): Promise<Record<StemId, Stereo>> {
  let done: { resolve: (stems: Record<StemId, Stereo>) => void; reject: (error: Error) => void } | null = null;
  let failed: Error | null = null;

  const fail = (error: Error) => {
    if (!failed) failed = error;
    done?.reject(error);
    done = null;
  };

  worker.onmessage = (event: MessageEvent<WorkerOutbound>) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "error") {
      fail(new Error(message.message || "Stem separation failed"));
      return;
    }
    if (message.type === "progress") {
      onProgress(Math.max(0, Math.min(1, message.fraction)));
      return;
    }
    done?.resolve(message.stems);
    done = null;
  };
  worker.onerror = (event) => {
    fail(new Error(event.message || "Stem separation failed"));
  };
  worker.onmessageerror = () => {
    fail(new Error("Stem separation worker message could not be deserialized"));
  };

  const left = new Float32Array(audio.left);
  const right = new Float32Array(audio.right);
  const result = new Promise<Record<StemId, Stereo>>((resolve, reject) => {
    done = { resolve, reject };
  });
  worker.postMessage({ type: "separate", left, right }, [left.buffer, right.buffer]);
  return result;
}

function emptyStems(length: number): Record<StemId, Stereo> {
  const stems = {} as Record<StemId, Stereo>;
  for (const id of STEM_IDS) {
    stems[id] = { left: new Float32Array(length), right: new Float32Array(length) };
  }
  return stems;
}
