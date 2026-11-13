export const STEM_IDS = ["drums", "vocals", "bass", "guitar", "rest"] as const;
export type StemId = (typeof STEM_IDS)[number];
export type WordLyric = { timeSec: number; word: string };
export type ChordChange = { beat: number; name: string };
export type SplitResult = {
  stems: Record<StemId, AudioBuffer>;
  durationSec: number;
  bpm: number;
  lyrics: WordLyric[];
  chords: ChordChange[];
};
export type SplitProgress = { stage: string; fraction: number };
export type SplitMp3 = (file: ArrayBuffer, onProgress: (progress: SplitProgress) => void) => Promise<SplitResult>;
