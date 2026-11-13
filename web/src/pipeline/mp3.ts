// lamejs 1.2.1 has no bundled types, and the published sources reference
// MPEGMode, Lame, and BitStream as free globals. Bundlers do not leak those
// CommonJS bindings, so they are pinned before an encoder is constructed.

declare module "lamejs" {
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right: Int16Array): Int8Array;
    flush(): Int8Array;
  }
}

declare module "lamejs/src/js/MPEGMode" {
  const MPEGMode: unknown;
  export default MPEGMode;
}

declare module "lamejs/src/js/Lame" {
  const Lame: unknown;
  export default Lame;
}

declare module "lamejs/src/js/BitStream" {
  const BitStream: unknown;
  export default BitStream;
}

import BitStream from "lamejs/src/js/BitStream";
import Lame from "lamejs/src/js/Lame";
import MPEGMode from "lamejs/src/js/MPEGMode";
import { Mp3Encoder } from "lamejs";

const globals = globalThis as unknown as {
  MPEGMode?: unknown;
  Lame?: unknown;
  BitStream?: unknown;
};
globals.MPEGMode = MPEGMode;
globals.Lame = Lame;
globals.BitStream = BitStream;

const FRAME_SAMPLES = 1152;
const BITRATE_KBPS = 128;

export function encodeMp3(left: Float32Array, right: Float32Array, sampleRate: number): Blob {
  const length = Math.max(left.length, right.length);
  const leftPcm = floatToInt16(left, length);
  const rightPcm = floatToInt16(right, length);
  const encoder = new Mp3Encoder(2, sampleRate, BITRATE_KBPS);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < length; offset += FRAME_SAMPLES) {
    const end = Math.min(offset + FRAME_SAMPLES, length);
    const frame = encoder.encodeBuffer(leftPcm.subarray(offset, end), rightPcm.subarray(offset, end));
    pushFrame(parts, frame);
  }
  pushFrame(parts, encoder.flush());
  return new Blob(parts, { type: "audio/mpeg" });
}

function floatToInt16(samples: Float32Array, length: number): Int16Array {
  const pcm = new Int16Array(length);
  const count = Math.min(length, samples.length);
  for (let i = 0; i < count; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return pcm;
}

function pushFrame(parts: Uint8Array[], frame: Int8Array): void {
  if (frame.byteLength === 0) return;
  parts.push(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
}
