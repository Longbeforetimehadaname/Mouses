import { useEffect, useRef, useState } from "react";
import type { SplitResult } from "./contract";
import { SyncPanel } from "./drive/SyncPanel";
import { deleteSong, listSongs, loadPlayable, saveSplitSong } from "./library/db";
import { errorText, progressPercent, titleFromFilename } from "./library/format";
import { LibraryHome } from "./library/LibraryHome";
import type { SongMeta } from "./library/types";
import { Player } from "./player/Player";
import { splitMp3 } from "./pipeline/split";

type OpenSong = {
  meta: SongMeta;
  result: SplitResult;
};

type Activity =
  | { kind: "split"; title: string; stage: string; fraction: number }
  | { kind: "save"; title: string };

export function App() {
  const [songs, setSongs] = useState<SongMeta[] | null>(null);
  const [screen, setScreen] = useState<"library" | "sync">("library");
  const [active, setActive] = useState<OpenSong | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const revision = useRef(0);

  async function refresh() {
    const ticket = ++revision.current;
    try {
      const rows = await listSongs();
      if (ticket === revision.current) setSongs(rows);
    } catch (caught) {
      if (ticket !== revision.current) return;
      setError(errorText(caught, "Songs on this phone could not be opened."));
      setSongs((current) => current ?? []);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  async function upload(file: File) {
    if (activity) return;
    const mp3 =
      file.name.toLowerCase().endsWith(".mp3") ||
      file.type === "audio/mpeg" ||
      file.type === "audio/mp3";
    if (!mp3) {
      setError("Choose an MP3 file.");
      return;
    }
    if (file.size === 0) {
      setError("That MP3 is empty.");
      return;
    }
    const title = titleFromFilename(file.name);
    setError(null);
    setActivity({ kind: "split", title, stage: "Starting", fraction: 0 });
    try {
      const original = await file.arrayBuffer();
      const result = await splitMp3(original.slice(0), (progress) => {
        setActivity({
          kind: "split",
          title,
          stage: progress.stage,
          fraction: progress.fraction,
        });
      });
      setActivity({ kind: "save", title });
      const meta = await saveSplitSong({
        title,
        original,
        originalType: file.type || "audio/mpeg",
        result,
      });
      await refresh();
      setActive({ meta, result });
    } catch (caught) {
      setError(errorText(caught, "Could not split that MP3."));
    } finally {
      setActivity(null);
    }
  }

  async function openSong(id: string) {
    if (openingId || activity) return;
    setOpeningId(id);
    setError(null);
    try {
      setActive(await loadPlayable(id));
    } catch (caught) {
      setError(errorText(caught, "Could not open that song."));
    } finally {
      setOpeningId(null);
    }
  }

  async function removeSong(id: string) {
    try {
      await deleteSong(id);
      if (active?.meta.id === id) setActive(null);
      await refresh();
    } catch (caught) {
      setError(errorText(caught, "Could not remove that song."));
    }
  }

  if (active) {
    return (
      <div className="player-host">
        <Player
          title={active.meta.title}
          stems={active.result.stems}
          durationSec={active.result.durationSec}
          bpm={active.result.bpm}
          lyrics={active.result.lyrics}
          chords={active.result.chords}
          onBack={() => setActive(null)}
        />
      </div>
    );
  }

  if (screen === "sync") {
    return (
      <SyncPanel
        onClose={() => setScreen("library")}
        onSynced={refresh}
      />
    );
  }

  const percent = activity?.kind === "split" ? progressPercent(activity.fraction) : 0;
  const stage =
    activity?.kind === "split" ? activity.stage.trim() || "Working" : "Saving on this phone";

  return (
    <>
      <LibraryHome
        songs={songs}
        error={error}
        onDismissError={() => setError(null)}
        onUpload={(file) => void upload(file)}
        uploadDisabled={activity !== null}
        onOpen={(id) => void openSong(id)}
        openingId={openingId}
        onDelete={(id) => void removeSong(id)}
        onSync={() => setScreen("sync")}
      />
      {activity ? (
        <div
          className="split-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="split-title"
        >
          <p className="eyebrow">{activity.kind === "save" ? "Saving" : "Splitting"}</p>
          <h2 id="split-title">{activity.title}</h2>
          <p className="stage" role="status">
            {stage}
          </p>
          {activity.kind === "split" ? (
            <>
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={stage}
              >
                <span style={{ width: `${percent}%` }} />
              </div>
              <p className="pct">{percent}%</p>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
