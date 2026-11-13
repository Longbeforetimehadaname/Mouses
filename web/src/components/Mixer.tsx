import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { StemEngine } from "../audio/engine";
import { STEM_IDS } from "../types";
import type { StemId } from "../types";
import { TempoControl } from "./TempoControl";
import { TrackStrip } from "./TrackStrip";
import { Transport } from "./Transport";
import "./player.css";

interface Channel {
  volume: number;
  mute: boolean;
  solo: boolean;
}

export function Mixer({ engine, bpm }: { engine: StemEngine; bpm?: number }) {
  const [channels, setChannels] = useState(defaultChannels);

  useEffect(() => {
    void engine.attach();
  }, [engine]);

  useEffect(() => {
    const anySolo = STEM_IDS.some((id) => channels[id]?.solo);
    for (const id of STEM_IDS) {
      const channel = channels[id];
      if (!channel) continue;
      engine.setStem(id, channel.volume, channel.mute, channel.solo, anySolo);
    }
  }, [engine, channels]);

  return (
    <section className="mixer" aria-label="Mixer">
      <div className="mixer-strips">
        {STEM_IDS.map((id) => {
          const channel = channels[id];
          if (!channel) return null;
          return (
            <TrackStrip
              key={id}
              id={id}
              volume={channel.volume}
              mute={channel.mute}
              solo={channel.solo}
              onVolume={(volume) => patchChannel(setChannels, id, { volume })}
              onMute={() => patchChannel(setChannels, id, (current) => ({ mute: !current.mute }))}
              onSolo={() => patchChannel(setChannels, id, (current) => ({ solo: !current.solo }))}
            />
          );
        })}
      </div>
      <Transport engine={engine} />
      <TempoControl engine={engine} bpm={bpm} />
    </section>
  );
}

function patchChannel(
  setChannels: Dispatch<SetStateAction<Record<StemId, Channel>>>,
  id: StemId,
  patch: Partial<Channel> | ((channel: Channel) => Partial<Channel>),
): void {
  setChannels((prev) => {
    const current = prev[id];
    if (!current) return prev;
    const next = typeof patch === "function" ? patch(current) : patch;
    return { ...prev, [id]: { ...current, ...next } };
  });
}

function defaultChannels(): Record<StemId, Channel> {
  const channels = {} as Record<StemId, Channel>;
  for (const id of STEM_IDS) channels[id] = { volume: 1, mute: false, solo: false };
  return channels;
}
