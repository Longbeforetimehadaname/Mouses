import { uploadSong } from "../drive/upload";
import { getSong, originalBlob, saveStem, updateSong } from "../storage/songs";
import { STEM_IDS, type SongMeta } from "../types";
import { detectChords } from "./chords";
import { transcribeVocals } from "./lyrics";
import { encodeMp3 } from "./mp3";
import { separate } from "./separate";

const MODEL_RATE = 44100;

interface ScreenWakeLock {
  release: () => Promise<void>;
}

export async function processSong(
  songId: string,
  onProgress?: (progress: number, stage: string) => void,
): Promise<void> {
  const wakeLock = await requestWakeLock();
  let chain: Promise<void> = Promise.resolve();
  const report = (progress: number, stage: string) => {
    onProgress?.(progress, stage);
    chain = chain.then(() => updateSong(songId, { progress, stage })).then(() => undefined);
  };

  try {
    report(0.01, "Reading audio");
    await chain;
    const original = await originalBlob(songId);
    if (!(original instanceof Blob) || original.size === 0) {
      throw new Error("Original audio is missing");
    }
    const audio = await decodeToStereo44100(original);

    report(0.05, "Separating instruments");
    const stems = await separate({ left: audio.left, right: audio.right }, (fraction) => {
      const clamped = Math.max(0, Math.min(1, fraction));
      report(0.05 + clamped * 0.65, "Separating instruments");
    });
    await chain;

    report(0.7, "Saving tracks");
    const files: { name: string; blob: Blob }[] = [{ name: "original.mp3", blob: original }];
    const vocals = { left: stems.vocals.left, right: stems.vocals.right };
    for (const stem of STEM_IDS) {
      const encoded = encodeMp3(stems[stem].left, stems[stem].right, MODEL_RATE);
      await saveStem(songId, stem, encoded);
      files.push({ name: `${stem}.mp3`, blob: encoded });
      stems[stem] = { left: new Float32Array(0), right: new Float32Array(0) };
    }
    await chain;

    report(0.75, "Reading lyrics");
    const words = await transcribeVocals(vocals.left, vocals.right, MODEL_RATE);
    report(0.9, "Reading lyrics");
    await chain;

    report(0.92, "Finding chords");
    const chords = detectChords(audio.left, audio.right, MODEL_RATE);
    await chain;

    const duration = audio.left.length / MODEL_RATE;
    const stored = await getSong(songId);
    await updateSong(songId, {
      status: "ready",
      duration,
      bpm: chords.bpm,
      words,
      beats: chords.beats,
      progress: 1,
      stage: "Ready",
    });
    onProgress?.(1, "Ready");

    try {
      await uploadSong(readyMeta(songId, stored, duration, chords.bpm, words, chords.beats), files);
    } catch {
      // Drive is best-effort. The local song stays ready.
    }
  } catch (error) {
    try {
      await chain;
    } catch {
      // A progress write failed; the original error is the one to surface.
    }
    const message = error instanceof Error ? error.message : String(error);
    try {
      await updateSong(songId, { status: "failed", error: message });
    } catch {
      // Still rethrow the pipeline error.
    }
    throw error;
  } finally {
    if (wakeLock) {
      try {
        await wakeLock.release();
      } catch {
        // Ignoring a wake-lock release failure matches a rejected request.
      }
    }
  }
}

function readyMeta(
  songId: string,
  stored: SongMeta | null | undefined,
  duration: number,
  bpm: number,
  words: SongMeta["words"],
  beats: SongMeta["beats"],
): SongMeta {
  return {
    id: songId,
    title: stored?.title ?? "Untitled",
    duration,
    status: "ready",
    progress: 1,
    stage: "Ready",
    bpm,
    words,
    beats,
    createdAt: stored?.createdAt ?? Date.now(),
  };
}

async function requestWakeLock(): Promise<ScreenWakeLock | null> {
  try {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<ScreenWakeLock> };
    };
    if (!nav.wakeLock) return null;
    return await nav.wakeLock.request("screen");
  } catch {
    return null;
  }
}

async function decodeToStereo44100(blob: Blob): Promise<{ left: Float32Array; right: Float32Array }> {
  const encoded = await blob.arrayBuffer();
  const context = await openAudioContext();
  try {
    const decoded = await context.decodeAudioData(encoded.slice(0));
    if (decoded.length === 0) throw new Error("Audio is empty");
    const left = new Float32Array(decoded.getChannelData(0));
    const right = new Float32Array(
      decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0),
    );
    if (decoded.sampleRate === MODEL_RATE) return { left, right };
    return resampleStereo(left, right, decoded.sampleRate, MODEL_RATE);
  } finally {
    await context.close();
  }
}

async function openAudioContext(): Promise<AudioContext> {
  try {
    return new AudioContext({ sampleRate: MODEL_RATE });
  } catch {
    return new AudioContext();
  }
}

async function resampleStereo(
  left: Float32Array,
  right: Float32Array,
  fromRate: number,
  toRate: number,
): Promise<{ left: Float32Array; right: Float32Array }> {
  const length = Math.max(left.length, right.length);
  const outLength = Math.max(1, Math.round(length * toRate / fromRate));
  const offline = new OfflineAudioContext(2, outLength, toRate);
  const buffer = offline.createBuffer(2, length, fromRate);
  buffer.copyToChannel(pad(left, length), 0);
  buffer.copyToChannel(pad(right, length), 1);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return {
    left: new Float32Array(rendered.getChannelData(0)),
    right: new Float32Array(rendered.getChannelData(1)),
  };
}

function pad(channel: Float32Array, length: number): Float32Array {
  if (channel.length === length) return channel;
  const padded = new Float32Array(length);
  padded.set(channel.subarray(0, Math.min(channel.length, length)));
  return padded;
}
