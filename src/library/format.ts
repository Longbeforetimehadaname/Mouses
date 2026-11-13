export function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof Error && caught.message.trim()) return caught.message;
  return fallback;
}

export function titleFromFilename(name: string): string {
  const base = name.replace(/^.*[/\\]/, "").replace(/\.mp3$/i, "").trim();
  return base || "Untitled";
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  return `${minutes}:${remain.toString().padStart(2, "0")}`;
}

export function formatBpm(bpm: number): string {
  if (!Number.isFinite(bpm) || bpm <= 0) return "";
  const rounded = Math.round(bpm * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded} BPM` : `${rounded.toFixed(1)} BPM`;
}

export function songInitials(title: string): string {
  const letters = title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("");
  return (letters || "M").toUpperCase();
}

export function coverHue(title: string): number {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function libraryEyebrow(count: number | null): string {
  if (count === null || count === 0) return "On this phone";
  return count === 1 ? "1 song on this phone" : `${count} songs on this phone`;
}

export function progressPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}
