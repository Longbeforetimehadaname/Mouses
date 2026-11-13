import React, { Suspense, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getSong } from "../storage/songs";
import type { SongMeta } from "../types";
import { formatDuration, progressFraction, statusLabel } from "./display";

const Mixer = React.lazy(
  () =>
    // @ts-ignore Mixer is owned by the player branch and may be absent here.
    import("../components/Mixer"),
);
const LyricsView = React.lazy(
  () =>
    // @ts-ignore LyricsView is owned by another branch and may be absent here.
    import("../components/LyricsView"),
);
const ChordsView = React.lazy(
  () =>
    // @ts-ignore ChordsView is owned by another branch and may be absent here.
    import("../components/ChordsView"),
);

type PanelId = "mixer" | "lyrics" | "chords";

const panels: { id: PanelId; label: string }[] = [
  { id: "mixer", label: "Mixer" },
  { id: "lyrics", label: "Lyrics" },
  { id: "chords", label: "Chords" },
];

class PanelBoundary extends React.Component<
  { children: React.ReactNode; label: string },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="panel-fallback" role="status">
          <p>{this.props.label} is not available in this build yet.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function SongPage() {
  const { id } = useParams();
  const [song, setSong] = useState<SongMeta | null | undefined>(undefined);
  const [tab, setTab] = useState<PanelId>("mixer");

  useEffect(() => {
    if (!id) {
      setSong(null);
      return;
    }
    let cancelled = false;
    let timer = 0;

    const load = () => {
      void getSong(id)
        .then((row) => {
          if (cancelled) return;
          setSong(row);
          if (!row || row.status !== "processing") window.clearInterval(timer);
        })
        .catch(() => {
          if (!cancelled) setSong(null);
        });
    };

    load();
    timer = window.setInterval(load, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [id]);

  const active = panels.find((panel) => panel.id === tab) ?? panels[0];

  return (
    <div className="song-screen">
      <header className="song-header">
        <Link to="/songs" className="back-button">
          Songs
        </Link>
        {song ? (
          <>
            <div className="song-title-row">
              <h1>{song.title}</h1>
              <span className="duration">{formatDuration(song.duration)}</span>
            </div>
            <p className={`status status-${song.status}`}>
              <span className="status-dot" aria-hidden="true" />
              {statusLabel(song.status)}
              {song.status === "processing" ? ` · ${song.stage} · ${progressFraction(song.progress)}` : ""}
            </p>
          </>
        ) : (
          <h1>{song === undefined ? "Loading…" : "Song not found"}</h1>
        )}
      </header>

      <div className="song-panel">
        {song?.status === "processing" ? (
          <p className="banner">
            Splitting runs on this phone. Keep Mouses open until this song finishes.
          </p>
        ) : null}
        {song?.status === "failed" && song.error ? (
          <p className="banner" role="alert">
            {song.error}
          </p>
        ) : null}
        {song ? (
          <PanelBoundary key={tab} label={active.label}>
            <Suspense fallback={<p className="panel-fallback">Loading {active.label}…</p>}>
              {tab === "mixer" ? <Mixer song={song} /> : null}
              {tab === "lyrics" ? <LyricsView song={song} /> : null}
              {tab === "chords" ? <ChordsView song={song} /> : null}
            </Suspense>
          </PanelBoundary>
        ) : null}
        {song === null ? (
          <p className="empty">This song is not on this phone.</p>
        ) : null}
      </div>

      <nav className="bottom-nav song-tabs" aria-label="Song">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={panel.id === tab ? "nav-tab active" : "nav-tab"}
            aria-current={panel.id === tab ? "page" : undefined}
            onClick={() => setTab(panel.id)}
          >
            {panel.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
