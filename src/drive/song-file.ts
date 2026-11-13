import {
  STEM_IDS,
  type ChordChange,
  type StemId,
  type WordLyric,
} from "../contract";
import type { SongAudio, SongMeta, StoredStem } from "../library/types";

export const SONG_FILE_EXTENSION = ".mousesong";

const MAGIC = [0x4d, 0x4f, 0x55, 0x53] as const;
const VERSION = 1;
const HEADER_BYTES = 10;

type OriginalPart = { kind: "original"; byteLength: number };
type StemPart = {
  kind: "stem";
  stemId: StemId;
  sampleRate: number;
  length: number;
  channelCount: number;
  byteLength: number;
};
type SongPart = OriginalPart | StemPart;

type SongHeader = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  durationSec: number;
  bpm: number;
  lyrics: WordLyric[];
  chords: ChordChange[];
  originalType: string;
  parts: SongPart[];
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeSongFile(meta: SongMeta, audio: SongAudio): Blob {
  const parts: SongPart[] = [
    { kind: "original", byteLength: audio.original.byteLength },
  ];
  const chunks: BlobPart[] = [audio.original];

  for (const stemId of STEM_IDS) {
    const stem = audio.stems[stemId];
    if (!stem) throw new Error(`Cannot sync a song missing the ${stemId} stem.`);
    let byteLength = 0;
    for (const channel of stem.channels) {
      byteLength += channel.byteLength;
      chunks.push(channel);
    }
    parts.push({
      kind: "stem",
      stemId,
      sampleRate: stem.sampleRate,
      length: stem.length,
      channelCount: stem.channels.length,
      byteLength,
    });
  }

  const header: SongHeader = {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    durationSec: meta.durationSec,
    bpm: meta.bpm,
    lyrics: meta.lyrics,
    chords: meta.chords,
    originalType: meta.originalType,
    parts,
  };
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  const prefix = new Uint8Array(HEADER_BYTES);
  prefix.set(MAGIC);
  const view = new DataView(prefix.buffer);
  view.setUint16(4, VERSION);
  view.setUint32(6, headerBytes.byteLength);
  return new Blob([prefix, headerBytes, ...chunks]);
}

export function decodeSongFile(buffer: ArrayBuffer): { meta: SongMeta; audio: SongAudio } {
  if (buffer.byteLength < HEADER_BYTES) throw new Error("Song file is too small.");
  const view = new DataView(buffer);
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (view.getUint8(index) !== MAGIC[index]) {
      throw new Error("Song file is not a Mouses song.");
    }
  }
  const version = view.getUint16(4);
  if (version !== VERSION) throw new Error(`Song file version ${version} is not supported.`);
  const headerLength = view.getUint32(6);
  const headerEnd = HEADER_BYTES + headerLength;
  if (headerLength < 2 || headerEnd > buffer.byteLength) {
    throw new Error("Song file header is truncated.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textDecoder.decode(new Uint8Array(buffer, HEADER_BYTES, headerLength)));
  } catch {
    throw new Error("Song file header is not valid JSON.");
  }
  const header = parseHeader(parsed);
  const bytes = new Uint8Array(buffer);
  let offset = headerEnd;
  let original: ArrayBuffer | null = null;
  const stems = {} as Record<StemId, StoredStem>;

  for (const part of header.parts) {
    if (part.byteLength < 0 || offset + part.byteLength > bytes.byteLength) {
      throw new Error("Song file audio is truncated.");
    }
    const slice = copyBytes(bytes, offset, part.byteLength);
    offset += part.byteLength;
    if (part.kind === "original") {
      if (original) throw new Error("Song file has two originals.");
      original = slice;
      continue;
    }
    if (stems[part.stemId]) throw new Error(`Song file repeats the ${part.stemId} stem.`);
    stems[part.stemId] = {
      sampleRate: part.sampleRate,
      length: part.length,
      channels: splitChannels(slice, part.channelCount, part.length),
    };
  }

  if (offset !== bytes.byteLength) throw new Error("Song file has trailing bytes.");
  if (!original) throw new Error("Song file is missing the original audio.");
  for (const id of STEM_IDS) {
    if (!stems[id]) throw new Error(`Song file is missing the ${id} stem.`);
  }

  return {
    meta: {
      id: header.id,
      title: header.title,
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
      durationSec: header.durationSec,
      bpm: header.bpm,
      lyrics: header.lyrics,
      chords: header.chords,
      originalType: header.originalType,
    },
    audio: { id: header.id, original, stems },
  };
}

function copyBytes(bytes: Uint8Array, start: number, length: number): ArrayBuffer {
  const copy = new Uint8Array(length);
  copy.set(bytes.subarray(start, start + length));
  return copy.buffer;
}

function splitChannels(buffer: ArrayBuffer, channelCount: number, length: number): ArrayBuffer[] {
  if (channelCount < 1 || channelCount > 8 || length < 1) {
    throw new Error("Song file has an invalid stem.");
  }
  if (buffer.byteLength !== channelCount * length * 4) {
    throw new Error("Song file stem length does not match.");
  }
  const view = new Uint8Array(buffer);
  const channelBytes = length * 4;
  const channels: ArrayBuffer[] = [];
  for (let index = 0; index < channelCount; index += 1) {
    channels.push(copyBytes(view, index * channelBytes, channelBytes));
  }
  return channels;
}

function parseHeader(value: unknown): SongHeader {
  const record = asRecord(value, "Song file header");
  const id = readString(record.id, "Song id");
  if (!/^[\w.-]+$/.test(id)) throw new Error("Song file id is invalid.");
  const partsValue = record.parts;
  if (!Array.isArray(partsValue) || partsValue.length === 0) {
    throw new Error("Song file is missing its audio parts.");
  }
  return {
    id,
    title: readString(record.title, "Song title"),
    createdAt: readTimestamp(record.createdAt, "createdAt"),
    updatedAt: readTimestamp(record.updatedAt, "updatedAt"),
    durationSec: readFinite(record.durationSec, "duration"),
    bpm: readFinite(record.bpm, "bpm"),
    lyrics: readLyrics(record.lyrics),
    chords: readChords(record.chords),
    originalType: readString(record.originalType, "Audio type"),
    parts: partsValue.map((part) => parsePart(part)),
  };
}

function parsePart(value: unknown): SongPart {
  const record = asRecord(value, "Song file part");
  const byteLength = readCount(record.byteLength, "Part size");
  if (record.kind === "original") return { kind: "original", byteLength };
  if (record.kind !== "stem") throw new Error("Song file has an unknown audio part.");
  if (!isStemId(record.stemId)) throw new Error("Song file has an unknown stem.");
  return {
    kind: "stem",
    stemId: record.stemId,
    sampleRate: readPositive(record.sampleRate, "sample rate"),
    length: readCount(record.length, "stem length"),
    channelCount: readCount(record.channelCount, "channel count"),
    byteLength,
  };
}

function readLyrics(value: unknown): WordLyric[] {
  if (!Array.isArray(value)) throw new Error("Song file lyrics are invalid.");
  return value.map((entry) => {
    const record = asRecord(entry, "Lyric");
    const timeSec = readFinite(record.timeSec, "Lyric time");
    const word = readString(record.word, "Lyric word");
    return { timeSec, word };
  });
}

function readChords(value: unknown): ChordChange[] {
  if (!Array.isArray(value)) throw new Error("Song file chords are invalid.");
  return value.map((entry) => {
    const record = asRecord(entry, "Chord");
    return {
      beat: readFinite(record.beat, "Chord beat"),
      name: readString(record.name, "Chord name"),
    };
  });
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid.`);
  return value;
}

function readFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function readTimestamp(value: unknown, label: string): number {
  const time = readFinite(value, label);
  if (time < 0) throw new Error(`${label} is invalid.`);
  return time;
}

function readCount(value: unknown, label: string): number {
  const count = readFinite(value, label);
  if (!Number.isInteger(count) || count < 0) throw new Error(`${label} is invalid.`);
  return count;
}

function readPositive(value: unknown, label: string): number {
  const number = readFinite(value, label);
  if (number <= 0) throw new Error(`${label} is invalid.`);
  return number;
}

function isStemId(value: unknown): value is StemId {
  return typeof value === "string" && (STEM_IDS as readonly string[]).includes(value);
}
