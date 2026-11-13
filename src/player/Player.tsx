import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react/jsx-runtime";
import { StemEngine } from "../../web/src/audio/engine";
import { ChordsView } from "../../web/src/components/ChordsView";
import { LyricsView } from "../../web/src/components/LyricsView";
import { Mixer } from "../../web/src/components/Mixer";
import { SongTabs } from "../../web/src/components/SongTabs";
import "../../web/src/components/player.css";
import { STEM_IDS } from "../../web/src/types";
import type { StemId } from "../../web/src/types";
import { chordBeats, lyricWords, type ChordChange, type TimedWord } from "./adapt";
import { audioBufferToWav, silentWav } from "./wav";

export function Player(props: {
  title: string;
  stems: Record<StemId, AudioBuffer>;
  durationSec: number;
  bpm: number;
  lyrics: TimedWord[];
  chords: ChordChange[];
  onBack: () => void;
}): JSX.Element {
  const { title, stems, durationSec, bpm, lyrics, chords, onBack } = props;
  const [tab, setTab] = useState<"mixer" | "lyrics" | "chords">("mixer");
  const [time, setTime] = useState(0);
  const [engine, setEngine] = useState<StemEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const words = useMemo(() => lyricWords(lyrics), [lyrics]);
  const beats = useMemo(() => chordBeats(chords, durationSec, bpm), [chords, durationSec, bpm]);

  useEffect(() => {
    const urls = urlsFor(stems, durationSec);
    let next: StemEngine;
    try {
      next = new StemEngine(urls);
    } catch (caught) {
      revoke(urls);
      setEngine(null);
      setError(caught instanceof Error ? caught.message : "Playback couldn't start in this browser.");
      return;
    }
    next.setSongBpm(bpm > 0 ? bpm : 120);
    setEngine(next);
    setError(null);
    const unsubscribe = next.subscribe((value) => setTime(value));
    void next.attach();
    return () => {
      unsubscribe();
      next.dispose();
      setEngine(null);
      revoke(urls);
    };
  }, [stems, durationSec, bpm]);

  return (
    <section className="player-screen" aria-label="Stem player">
      <header className="player-top">
        <button type="button" className="player-back" onClick={onBack}>
          Back
        </button>
        <h1 className="player-title">{title}</h1>
      </header>
      <SongTabs tab={tab} onChange={setTab} />
      <div className="player-body">
        {error ? <p className="player-status">{error}</p> : null}
        {tab === "mixer" ? (
          engine ? (
            <Mixer engine={engine} bpm={bpm} />
          ) : (
            <p className="player-status">Loading stems…</p>
          )
        ) : null}
        {tab === "lyrics" ? (
          <div role="tabpanel" aria-labelledby="song-tab-lyrics">
            <LyricsView words={words} time={time} />
          </div>
        ) : null}
        {tab === "chords" ? (
          <div role="tabpanel" aria-labelledby="song-tab-chords">
            <ChordsView beats={beats} time={time} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function urlsFor(stems: Record<StemId, AudioBuffer>, durationSec: number): Record<StemId, string> {
  const urls = {} as Record<StemId, string>;
  for (const id of STEM_IDS) {
    const stem = stems[id];
    const blob = stem && stem.length > 0 ? audioBufferToWav(stem) : silentWav(durationSec);
    urls[id] = URL.createObjectURL(blob);
  }
  return urls;
}

function revoke(urls: Record<StemId, string>): void {
  for (const id of STEM_IDS) {
    const url = urls[id];
    if (url) URL.revokeObjectURL(url);
  }
}
