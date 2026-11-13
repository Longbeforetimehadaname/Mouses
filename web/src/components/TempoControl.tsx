import { useEffect, useState } from "react";
import type { StemEngine } from "../audio/engine";

export function TempoControl({ engine }: { engine: StemEngine }) {
  const [on, setOn] = useState(false);
  const [percent, setPercent] = useState(100);

  useEffect(() => {
    engine.setTempo(percent / 100);
  }, [engine, percent]);

  return (
    <div className="tempo-control">
      <button
        type="button"
        className={on ? "tempo-toggle is-on" : "tempo-toggle"}
        aria-pressed={on}
        aria-label="Metronome"
        onClick={() => setOn((value) => !value)}
      >
        <MetronomeIcon />
      </button>
      {on ? (
        <label className="tempo-slider">
          <span className="tempo-readout">{percent}%</span>
          <input
            type="range"
            min={50}
            max={150}
            step={1}
            value={percent}
            aria-label="Tempo"
            aria-valuetext={`${percent} percent`}
            onChange={(event) => setPercent(Number(event.target.value))}
          />
        </label>
      ) : null}
    </div>
  );
}

function MetronomeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        d="M5.4 20.6h13.2L12.9 3.8a1 1 0 0 0-1.8 0L5.4 20.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 18.2 17.4 5.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="17.9" cy="4.9" r="1.7" fill="currentColor" />
      <path
        d="M8.8 9.4h1.7M8.2 12.5h2M7.6 15.6h2.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
    </svg>
  );
}
