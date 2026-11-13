import { useRef } from "react";
import "./player.css";

const TABS = [
  { id: "mixer", label: "Mixer" },
  { id: "lyrics", label: "Lyrics" },
  { id: "chords", label: "Chords" },
] as const;

export function SongTabs({
  tab,
  onChange,
}: {
  tab: "mixer" | "lyrics" | "chords";
  onChange: (tab: "mixer" | "lyrics" | "chords") => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div className="song-tabs" role="tablist" aria-label="Song">
      {TABS.map((item, index) => {
        const selected = tab === item.id;
        return (
          <button
            key={item.id}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`song-tab-${item.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={selected ? "is-active" : undefined}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
              event.preventDefault();
              const current = TABS.findIndex((entry) => entry.id === tab);
              const delta = event.key === "ArrowRight" ? 1 : -1;
              const next = (current + delta + TABS.length) % TABS.length;
              onChange(TABS[next].id);
              buttons.current[next]?.focus();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
