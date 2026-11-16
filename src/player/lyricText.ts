import type { TimedWord } from "./adapt";

/** A .txt name, or the text/plain type iPhone Safari sometimes sends alone. */
export function isPlainTextFile(file: Pick<File, "name" | "type">): boolean {
  const name = file.name.trim().toLowerCase();
  if (name.endsWith(".txt")) return true;
  const type = file.type.trim().toLowerCase();
  return type === "text/plain" || type.startsWith("text/plain;");
}

/**
 * Split a plain lyric file into words and space them evenly from the start
 * of the song through its duration. Blank lines and other whitespace are gaps,
 * not words. An empty file returns no words.
 */
export function timedWordsFromLyricText(text: string, durationSec: number): TimedWord[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];
  const duration = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const count = words.length;
  return words.map((word, index) => ({
    word,
    timeSec: (index * duration) / count,
  }));
}
