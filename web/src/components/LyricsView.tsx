import { useEffect, useMemo, useRef } from "react";
import type { LyricWord } from "../types";
import "./player.css";

const WORDS_PER_LINE = 6;

export function LyricsView({ words, time }: { words: LyricWord[]; time: number }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLSpanElement>(null);

  const lines = useMemo(() => {
    const grouped: LyricWord[][] = [];
    for (let i = 0; i < words.length; i += WORDS_PER_LINE) grouped.push(words.slice(i, i + WORDS_PER_LINE));
    return grouped;
  }, [words]);

  const activeIndex = useMemo(() => {
    let found = -1;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word && time >= word.start && time <= word.end) found = i;
    }
    return found;
  }, [words, time]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || activeIndex < 0) return;

    const center = () => {
      const el = activeRef.current;
      if (!el) return;
      const sRect = scroller.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      if (sRect.height === 0 || eRect.height === 0) return;
      const delta = eRect.top + eRect.height / 2 - (sRect.top + sRect.height / 2);
      if (Math.abs(delta) < 1) return;
      scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: scrollBehavior() });
    };

    center();
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) center();
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [activeIndex]);

  if (words.length === 0) {
    return (
      <div className="lyrics-view is-empty">
        <p>Lyrics will show up here after the song is processed.</p>
      </div>
    );
  }

  return (
    <div className="lyrics-view" ref={scrollerRef}>
      {lines.map((line, lineIndex) => {
        return (
          <p className="lyric-line" key={lineIndex}>
            {line.map((word, offset) => {
              const index = lineIndex * WORDS_PER_LINE + offset;
              const active = index === activeIndex;
              return (
                <span
                  key={index}
                  ref={active ? activeRef : undefined}
                  className={active ? "lyric-word is-current" : "lyric-word"}
                  aria-current={active ? "true" : undefined}
                >
                  {word.text}
                </span>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

function scrollBehavior(): ScrollBehavior {
  if (typeof window === "undefined") return "auto";
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
