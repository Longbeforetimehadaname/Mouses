import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { SongMeta } from "./types";
import {
  coverHue,
  formatBpm,
  formatDuration,
  libraryEyebrow,
  songInitials,
} from "./format";

export function LibraryHome(props: {
  songs: SongMeta[] | null;
  error: string | null;
  onDismissError: () => void;
  onUpload: (file: File) => void;
  uploadDisabled: boolean;
  onOpen: (id: string) => void;
  openingId: string | null;
  onDelete: (id: string) => void;
  onSync: () => void;
}) {
  const [pending, setPending] = useState<SongMeta | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const busy = props.openingId !== null || props.uploadDisabled;

  useEffect(() => {
    if (!pending) return;
    keepRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPending(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  return (
    <div className="app-shell">
      <header className="top">
        <div>
          <p className="eyebrow">{libraryEyebrow(props.songs?.length ?? null)}</p>
          <h1>Mouses</h1>
        </div>
        <button
          type="button"
          className="text-button"
          onClick={props.onSync}
          disabled={props.uploadDisabled}
        >
          Sync
        </button>
      </header>

      <main className="library">
        {props.error ? (
          <div className="error-banner" role="alert">
            <p>{props.error}</p>
            <button type="button" onClick={props.onDismissError}>
              Dismiss
            </button>
          </div>
        ) : null}

        {props.songs === null ? (
          <p className="loading-copy">Opening songs on this phone…</p>
        ) : props.songs.length === 0 ? (
          <div className="empty">
            <svg className="empty-mark" viewBox="0 0 80 80" aria-hidden="true">
              <g fill="currentColor">
                <circle cx="26" cy="24" r="12" />
                <circle cx="54" cy="24" r="12" />
                <ellipse cx="40" cy="48" rx="22" ry="18" />
              </g>
              <circle className="nose" cx="40" cy="50" r="3.5" />
            </svg>
            <h2>No songs yet</h2>
            <p>
              Add an MP3. Mouses splits it on this phone and keeps the stems here, with or
              without a network.
            </p>
          </div>
        ) : (
          <div className="song-grid">
            {props.songs.map((song) => {
              const bpm = formatBpm(song.bpm);
              const style = { "--hue": String(coverHue(song.title)) } as CSSProperties;
              return (
                <article className="tile" key={song.id}>
                  <button
                    type="button"
                    className="tile-open"
                    aria-label={`Open ${song.title}`}
                    aria-busy={props.openingId === song.id}
                    disabled={busy}
                    onClick={() => props.onOpen(song.id)}
                  >
                    <span className="mark" style={style}>
                      {songInitials(song.title)}
                    </span>
                    <span className="tile-copy">
                      <span className="tile-title">{song.title}</span>
                      <span className="tile-meta">
                        {formatDuration(song.durationSec)}
                        {bpm ? ` · ${bpm}` : ""}
                      </span>
                      {props.openingId === song.id ? (
                        <span className="tile-state">Opening</span>
                      ) : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${song.title}`}
                    disabled={busy}
                    onClick={() => setPending(song)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </main>

      <div className="dock">
        <label className={props.uploadDisabled ? "add-button is-disabled" : "add-button"}>
          <span>Add an MP3</span>
          <input
            className="file-input"
            type="file"
            accept=".mp3,audio/mpeg,audio/mp3"
            disabled={props.uploadDisabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) props.onUpload(file);
            }}
          />
        </label>
      </div>

      {pending ? (
        <div className="modal-back" onClick={() => setPending(null)}>
          <div
            className="sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-title">Remove this song?</h2>
            <p>
              {pending.title} leaves this phone. The next sync also removes the Drive copy
              when that copy has not changed since.
            </p>
            <div className="sheet-actions">
              <button
                type="button"
                className="text-button"
                ref={keepRef}
                onClick={() => setPending(null)}
              >
                Keep
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const id = pending.id;
                  setPending(null);
                  props.onDelete(id);
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
