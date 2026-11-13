import type { ChordChange, StemId, WordLyric } from "../contract";

/** Float32 PCM for one stem, one ArrayBuffer per channel. */
export type StoredStem = {
  sampleRate: number;
  length: number;
  channels: ArrayBuffer[];
};

/** Metadata kept for the home screen and for Drive sync. */
export type SongMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  durationSec: number;
  bpm: number;
  lyrics: WordLyric[];
  chords: ChordChange[];
  originalType: string;
  driveFileId?: string;
};

/** Original MP3 bytes plus the five stem buffers. */
export type SongAudio = {
  id: string;
  original: ArrayBuffer;
  stems: Record<StemId, StoredStem>;
};

export type Tombstone = {
  id: string;
  deletedAt: number;
};
