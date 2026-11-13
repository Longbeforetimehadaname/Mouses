import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AddSongButton } from "../components/AddSongButton";
import { createSong, getSong, listSongs, updateSong } from "../storage/songs";
import type { SongMeta } from "../types";
import { formatDuration, progressFraction, progressPercent, statusLabel } from "./display";

const PIPELINE_MISSING =
  "Stem splitting is not available in this build yet. This song is saved on this phone.";

export function SongsPage() {
  const [songs, setSongs] = useState<SongMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const dirty = useRef(false);

  const upsert = useCallback((song: SongMeta) => {
    dirty.current = true;
    setSongs((current) => {
      const next = current.filter((item) => item.id !== song.id);
      next.push(song);
      next.sort((a, b) => b.createdAt - a.createdAt);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listSongs()
      .then((rows) => {
        if (!cancelled && !dirty.current) setSongs(rows);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBanner(error instanceof Error ? error.message : "Could not read songs on this phone.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const processing = songs.some((song) => song.status === "processing");

  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => {
      void listSongs()
        .then((rows) => setSongs(rows))
        .catch(() => undefined);
    }, 800);
    return () => window.clearInterval(timer);
  }, [processing]);

  async function handleFile(file: File) {
    setBanner(null);
    let song: SongMeta;
    try {
      song = await createSong(file);
    } catch (error) {
      setBanner(error instanceof Error ? error.message : "Could not save that song on this phone.");
      return;
    }
    upsert(song);

    const report = async (patch: Partial<SongMeta>) => {
      upsert(await updateSong(song.id, patch));
    };

    try {
      // @ts-ignore processSong is owned by the pipeline branch and may be absent here.
      const { processSong } = await import("../pipeline/processSong");
      if (typeof processSong !== "function") {
        upsert(await updateSong(song.id, { status: "failed", stage: "Failed", error: PIPELINE_MISSING }));
        return;
      }
      try {
        await processSong(song, report);
        const latest = await getSong(song.id);
        if (latest?.status === "processing") {
          upsert(await updateSong(song.id, { status: "ready", progress: 1, stage: "Ready" }));
        } else if (latest) {
          upsert(latest);
        }
      } catch (error) {
        const latest = await getSong(song.id);
        if (latest?.status === "failed") {
          upsert(latest);
          return;
        }
        const message = error instanceof Error && error.message ? error.message : "Stem splitting failed.";
        upsert(await updateSong(song.id, { status: "failed", stage: "Failed", error: message }));
      }
    } catch {
      upsert(await updateSong(song.id, { status: "failed", stage: "Failed", error: PIPELINE_MISSING }));
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <p className="mark">Mouses</p>
        <h1>Songs</h1>
      </header>
      <AddSongButton onFile={(file) => void handleFile(file)} />
      {banner ? (
        <p className="banner" role="alert">
          {banner}
        </p>
      ) : null}
      {!loaded ? null : songs.length === 0 ? (
        <p className="empty">Songs you add stay on this phone.</p>
      ) : (
        <ul className="song-list">
          {songs.map((song) => (
            <li key={song.id}>
              <Link to={`/songs/${song.id}`} className="song-card">
                <div className="song-card-top">
                  <h2>{song.title}</h2>
                  <span className="duration">{formatDuration(song.duration)}</span>
                </div>
                <p className={`status status-${song.status}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {statusLabel(song.status)}
                </p>
                {song.status === "processing" ? (
                  <div className="progress-block">
                    <div className="progress-line">
                      <span>{song.stage}</span>
                      <span>{progressFraction(song.progress)}</span>
                    </div>
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progressPercent(song.progress)}
                      aria-label={song.stage}
                    >
                      <div
                        className="progress-fill"
                        style={{ width: `${progressPercent(song.progress)}%` }}
                      />
                    </div>
                  </div>
                ) : null}
                {song.status === "failed" && song.error ? <p className="song-error">{song.error}</p> : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
