import type { SongStatus } from "../types";

export function formatDuration(duration: number): string {
  if (!Number.isFinite(duration) || duration <= 0) return "0:00";
  const total = Math.round(duration);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** `progress` is a fraction from 0 to 1. The label is that fraction out of 100. */
export function progressPercent(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress * 100)));
}

export function progressFraction(progress: number): string {
  return `${progressPercent(progress)}/100`;
}

export function statusLabel(status: SongStatus): string {
  switch (status) {
    case "processing":
      return "Processing";
    case "ready":
      return "Ready";
    case "failed":
      return "Failed";
  }
}
