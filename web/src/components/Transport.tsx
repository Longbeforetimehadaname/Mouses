import { useEffect, useRef, useState } from "react";
import type { StemEngine } from "../audio/engine";

export function Transport({ engine }: { engine: StemEngine }) {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const dragging = useRef(false);

  useEffect(() => {
    return engine.subscribe((next) => {
      if (!dragging.current) setTime(next);
      setDuration(engine.duration);
      setPlaying(engine.playing);
    });
  }, [engine]);

  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const shown = max > 0 ? Math.min(Math.max(time, 0), max) : 0;

  return (
    <div className="transport">
      <button
        type="button"
        className="transport-play"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          if (playing) engine.pause();
          else engine.play();
        }}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
        <span>{playing ? "Pause" : "Play"}</span>
      </button>
      <input
        className="transport-seek"
        type="range"
        min={0}
        max={max}
        step={0.01}
        value={shown}
        aria-label="Seek"
        onPointerDown={() => {
          dragging.current = true;
          const stop = () => {
            dragging.current = false;
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
          };
          window.addEventListener("pointerup", stop);
          window.addEventListener("pointercancel", stop);
        }}
        onChange={(event) => {
          const next = Number(event.target.value);
          setTime(next);
          engine.seek(next);
        }}
      />
      <span className="transport-time">
        {formatClock(shown)} / {formatClock(max)}
      </span>
    </div>
  );
}

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const ss = String(secs).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13l11-6.5-11-6.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M7 5h3.2v14H7V5zm6.8 0H17v14h-3.2V5z" fill="currentColor" />
    </svg>
  );
}
