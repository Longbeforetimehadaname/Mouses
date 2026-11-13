import type { CSSProperties } from "react";
import type { StemId } from "../types";

const COLORS: Record<StemId, string> = {
  drums: "#f5a623",
  vocals: "#ff5d8f",
  bass: "#b388ff",
  guitar: "#7dce6a",
  rest: "#4aa3ff",
};

const LABELS: Record<StemId, string> = {
  drums: "Drums",
  vocals: "Vocals",
  bass: "Bass",
  guitar: "Guitar",
  rest: "Rest",
};

export function TrackStrip({
  id,
  volume,
  mute,
  solo,
  onVolume,
  onMute,
  onSolo,
}: {
  id: StemId;
  volume: number;
  mute: boolean;
  solo: boolean;
  onVolume: (n: number) => void;
  onMute: () => void;
  onSolo: () => void;
}) {
  const label = LABELS[id];
  return (
    <div className="track-strip" style={{ "--stem": COLORS[id] } as CSSProperties}>
      <span className="track-label">{label}</span>
      <div className="volume-slot">
        <input
          className="volume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          aria-label={`${label} volume`}
          aria-valuetext={`${Math.round(volume * 100)} percent`}
          onChange={(event) => onVolume(Number(event.target.value))}
        />
      </div>
      <button type="button" className={mute ? "is-on" : undefined} aria-pressed={mute} aria-label={`Mute ${label}`} onClick={onMute}>
        Mute
      </button>
      <button type="button" className={solo ? "is-on" : undefined} aria-pressed={solo} aria-label={`Solo ${label}`} onClick={onSolo}>
        Solo
      </button>
    </div>
  );
}
