/** 16-bit WAV so the existing stem engine can play AudioBuffers through media elements. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Blob {
  const first = channels[0];
  const frames = first ? first.length : 0;
  const count = Math.max(1, channels.length);
  const rate = sampleRate > 0 ? Math.round(sampleRate) : 44100;
  const blockAlign = count * 2;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < count; channel++) {
      const data = channels[channel] ?? first;
      const sample = data && frame < data.length ? data[frame] ?? 0 : 0;
      view.setInt16(offset, floatToInt16(sample), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels: Float32Array[] = [];
  for (let index = 0; index < buffer.numberOfChannels; index++) {
    const data = buffer.getChannelData(index);
    const copy = new Float32Array(data.length);
    copy.set(data);
    channels.push(copy);
  }
  if (channels.length === 0) channels.push(new Float32Array(Math.max(1, buffer.length)));
  return encodeWav(channels, buffer.sampleRate);
}

export function silentWav(durationSec: number, sampleRate = 22050): Blob {
  const frames = Math.max(1, Math.floor((durationSec > 0 ? durationSec : 1) * sampleRate));
  return encodeWav([new Float32Array(frames)], sampleRate);
}

function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
}
