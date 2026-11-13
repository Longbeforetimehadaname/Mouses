import { useEffect, useMemo, useRef } from "react";
import type { ChordBeat } from "../types";
import "./player.css";

export function ChordsView({ beats, time }: { beats: ChordBeat[]; time: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const grid = useMemo(() => buildChordGrid(beats, time), [beats, time]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = rowRef.current;
    if (!scroller || !row || !grid.activeRow) return;

    const reveal = () => {
      const current = rowRef.current;
      if (!current) return;
      const sRect = scroller.getBoundingClientRect();
      const rRect = current.getBoundingClientRect();
      if (sRect.height === 0 || rRect.height === 0) return;
      let delta = 0;
      if (rRect.top < sRect.top) delta = rRect.top - sRect.top;
      else if (rRect.bottom > sRect.bottom) delta = rRect.bottom - sRect.bottom;
      if (Math.abs(delta) < 1) return;
      scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: scrollBehavior() });
    };

    reveal();
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) reveal();
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [grid.activeRow]);

  if (beats.length === 0) {
    return (
      <div className="chords-view is-empty">
        <p>Chords will show up here after the song is processed.</p>
      </div>
    );
  }

  return (
    <div className="chords-view" ref={scrollerRef}>
      <div className="chord-grid">
        {grid.rows.map((row) => {
          const currentRow = row.id === grid.activeRow;
          return (
            <div className="chord-bar" key={row.id} ref={currentRow ? rowRef : undefined}>
              {row.cells.map((beat, index) => {
                const current = currentRow && index === grid.activeCol;
                const label = beat && beat.chord != null ? beat.chord : "";
                return (
                  <div key={index} className={current ? "chord-beat is-current" : "chord-beat"}>
                    {label}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ChordRow {
  id: string;
  cells: (ChordBeat | null)[];
}

function buildChordGrid(beats: ChordBeat[], time: number): {
  rows: ChordRow[];
  activeRow: string | null;
  activeCol: number;
} {
  const current = latestBeat(beats, time);
  if (beats.length === 0) return { rows: [], activeRow: null, activeCol: -1 };

  if (chunkSequentially(beats)) {
    const rows: ChordRow[] = [];
    let activeRow: string | null = null;
    let activeCol = -1;
    for (let i = 0; i < beats.length; i += 4) {
      const id = `chunk-${i / 4}`;
      const cells: (ChordBeat | null)[] = [null, null, null, null];
      for (let col = 0; col < 4 && i + col < beats.length; col++) {
        const beat = beats[i + col];
        if (!beat) continue;
        cells[col] = beat;
        if (beat === current) {
          activeRow = id;
          activeCol = col;
        }
      }
      rows.push({ id, cells });
    }
    return { rows, activeRow, activeCol };
  }

  const oneBased = usesOneBasedBeats(beats);
  const byBar = new Map<number, (ChordBeat | null)[]>();
  for (const beat of beats) {
    let cells = byBar.get(beat.bar);
    if (!cells) {
      cells = [null, null, null, null];
      byBar.set(beat.bar, cells);
    }
    cells[slotFor(beat.beat, oneBased)] = beat;
  }

  const rows = [...byBar.keys()]
    .sort((a, b) => a - b)
    .map((bar) => ({ id: `bar-${bar}`, cells: byBar.get(bar) ?? [null, null, null, null] }));

  if (!current) return { rows, activeRow: null, activeCol: -1 };
  return {
    rows,
    activeRow: `bar-${current.bar}`,
    activeCol: slotFor(current.beat, oneBased),
  };
}

function latestBeat(beats: ChordBeat[], time: number): ChordBeat | null {
  let best: ChordBeat | null = null;
  for (const beat of beats) {
    if (beat.time <= time && (best === null || beat.time >= best.time)) best = beat;
  }
  return best;
}

function chunkSequentially(beats: ChordBeat[]): boolean {
  if (beats.length <= 4) return false;
  const bars = new Set(beats.map((beat) => beat.bar));
  return bars.size < 2;
}

function usesOneBasedBeats(beats: ChordBeat[]): boolean {
  let sawZero = false;
  let sawFour = false;
  for (const beat of beats) {
    if (beat.beat <= 0) sawZero = true;
    if (beat.beat >= 4) sawFour = true;
  }
  if (sawZero && !sawFour) return false;
  if (sawFour && !sawZero) return true;
  return !sawZero;
}

function slotFor(beat: number, oneBased: boolean): number {
  const index = oneBased ? beat - 1 : beat;
  if (index < 0) return 0;
  if (index > 3) return 3;
  return Math.floor(index);
}

function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
