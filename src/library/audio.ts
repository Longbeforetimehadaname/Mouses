import { STEM_IDS, type StemId } from "../contract";
import type { StoredStem } from "./types";

export function captureAudioBuffer(buffer: AudioBuffer): StoredStem {
  if (buffer.numberOfChannels < 1 || buffer.length < 1) {
    throw new Error("A stem came back empty.");
  }
  const channels: ArrayBuffer[] = [];
  for (let index = 0; index < buffer.numberOfChannels; index += 1) {
    const channel = buffer.getChannelData(index);
    const copy = new Float32Array(channel.length);
    copy.set(channel);
    channels.push(copy.buffer);
  }
  return {
    sampleRate: buffer.sampleRate,
    length: buffer.length,
    channels,
  };
}

export function captureStems(
  stems: Record<StemId, AudioBuffer>,
): Record<StemId, StoredStem> {
  const stored = {} as Record<StemId, StoredStem>;
  for (const id of STEM_IDS) {
    const buffer = stems[id];
    if (!buffer) throw new Error(`Split result is missing the ${id} stem.`);
    stored[id] = captureAudioBuffer(buffer);
  }
  return stored;
}

export function restoreAudioBuffer(stored: StoredStem): AudioBuffer {
  if (stored.channels.length < 1 || stored.length < 1 || !Number.isFinite(stored.sampleRate)) {
    throw new Error("A saved stem has no audio.");
  }
  let offline: OfflineAudioContext;
  try {
    offline = new OfflineAudioContext(stored.channels.length, stored.length, stored.sampleRate);
  } catch {
    throw new Error("A saved stem could not be restored on this phone.");
  }
  const buffer = offline.createBuffer(stored.channels.length, stored.length, stored.sampleRate);
  stored.channels.forEach((channel, index) => {
    const samples = new Float32Array(channel);
    if (samples.length !== stored.length) throw new Error("A saved stem is the wrong length.");
    buffer.copyToChannel(samples, index);
  });
  return buffer;
}

export function restoreStems(
  stems: Record<StemId, StoredStem>,
): Record<StemId, AudioBuffer> {
  const restored = {} as Record<StemId, AudioBuffer>;
  for (const id of STEM_IDS) {
    const stem = stems[id];
    if (!stem) throw new Error(`Saved song is missing the ${id} stem.`);
    restored[id] = restoreAudioBuffer(stem);
  }
  return restored;
}
