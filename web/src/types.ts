export type StemId = "drums" | "vocals" | "bass" | "guitar" | "rest";
export const STEM_IDS: StemId[] = ["drums", "vocals", "bass", "guitar", "rest"];
export type SongStatus = "processing" | "ready" | "failed";
export interface LyricWord { text: string; start: number; end: number; }
export interface ChordBeat { bar: number; beat: number; chord: string | null; time: number; }
export interface SongMeta {
  id: string; title: string; duration: number; status: SongStatus; progress: number;
  stage: string; error?: string; bpm: number; words: LyricWord[]; beats: ChordBeat[]; createdAt: number;
}
