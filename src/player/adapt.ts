import type { ChordBeat, LyricWord } from "../../web/src/types";

export type TimedWord = { timeSec: number; word: string };
export type ChordChange = { beat: number; name: string; timeSec?: number };

/** Map shell words onto the lyric view, which centers the active word. */
export function lyricWords(lyrics: readonly TimedWord[]): LyricWord[] {
  const ordered = lyrics
    .filter((lyric) => Number.isFinite(lyric.timeSec))
    .map((lyric, index) => ({ word: lyric.word, timeSec: lyric.timeSec, index }))
    .sort((a, b) => a.timeSec - b.timeSec || a.index - b.index);

  return ordered.map((lyric, index) => {
    const next = ordered[index + 1];
    const end = next ? next.timeSec : lyric.timeSec + 0.5;
    return {
      text: lyric.word,
      start: lyric.timeSec,
      end: Math.max(end, lyric.timeSec),
    };
  });
}

/**
 * One cell per beat in 4/4. The chord name is stored only on the beat where it changes.
 */
export function chordBeats(
  changes: readonly ChordChange[],
  durationSec: number,
  bpm: number,
): ChordBeat[] {
  const tempo = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const beatDur = 60 / tempo;
  const origin = gridOrigin(changes, beatDur);
  const durationBeats = durationSec > origin ? Math.ceil((durationSec - origin) / beatDur) : 0;
  const names = new Map<number, string>();
  let lastChange = 0;
  const sorted = changes
    .filter((change) => Number.isFinite(change.beat))
    .slice()
    .sort((a, b) => a.beat - b.beat);
  for (const change of sorted) {
    const beat = Math.round(change.beat);
    if (beat < 0) continue;
    names.set(beat, change.name);
    if (beat + 1 > lastChange) lastChange = beat + 1;
  }
  const count = Math.ceil(Math.max(4, durationBeats, lastChange) / 4) * 4;
  const beats: ChordBeat[] = [];
  for (let index = 0; index < count; index++) {
    beats.push({
      bar: Math.floor(index / 4),
      beat: index % 4,
      chord: names.get(index) ?? null,
      time: origin + index * beatDur,
    });
  }
  return beats;
}

function gridOrigin(changes: readonly ChordChange[], beatDur: number): number {
  for (const change of changes) {
    if (typeof change.timeSec !== "number" || !Number.isFinite(change.timeSec)) continue;
    const origin = change.timeSec - change.beat * beatDur;
    if (Number.isFinite(origin)) return origin;
  }
  return 0;
}
