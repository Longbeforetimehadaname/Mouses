import { STEM_IDS } from "../types";
import type { StemId } from "../types";

const DRIFT_INTERVAL_MS = 500;
const DRIFT_LIMIT_SECONDS = 0.04;

/**
 * Five HTML media elements, one per stem, summed in a single AudioContext.
 * The context is created and resumed inside play() so the first tap counts
 * as the iPhone Safari user gesture. Pitch correction is one worklet on the
 * mix, not a shifter per stem. Mute and solo only change gain — every stem
 * keeps playing so the clocks stay aligned.
 */
export class StemEngine {
  private readonly urls: Record<StemId, string>;
  private readonly elements = new Map<StemId, HTMLAudioElement>();
  private readonly gains = new Map<StemId, GainNode>();
  private readonly wanted = new Map<StemId, number>();
  private readonly sources: MediaElementAudioSourceNode[] = [];
  private readonly listeners = new Set<(time: number) => void>();
  private readonly leadId: StemId = STEM_IDS[0];

  private context: AudioContext | null = null;
  private pitchNode: AudioWorkletNode | null = null;
  private _pitchCorrection = false;
  private wired = false;
  private disposed = false;
  private playingFlag = false;
  private pausing = false;
  private tempo = 1;
  private attachTask: Promise<void> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private raf: number | null = null;
  private unlockFrame: number | null = null;

  constructor(urls: Record<StemId, string>) {
    this.urls = { ...urls };
    for (const id of STEM_IDS) {
      const audio = new Audio();
      audio.preload = "auto";
      audio.autoplay = false;
      audio.controls = false;
      audio.setAttribute("playsinline", "true");
      audio.setAttribute("webkit-playsinline", "true");
      this.unlock(audio);
      this.elements.set(id, audio);
    }

    this.element(this.leadId).addEventListener("ended", () => {
      if (!this.playingFlag) return;
      this.pause();
    });
  }

  get pitchCorrection(): boolean {
    return this._pitchCorrection;
  }

  get playing(): boolean {
    return this.playingFlag;
  }

  get currentTime(): number {
    const time = this.element(this.leadId).currentTime;
    return Number.isFinite(time) ? time : 0;
  }

  get duration(): number {
    let max = 0;
    for (const audio of this.elements.values()) {
      if (Number.isFinite(audio.duration) && audio.duration > max) max = audio.duration;
    }
    return max;
  }

  attach(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.attachTask) this.attachTask = this.loadAll();
    return this.attachTask;
  }

  play(): void {
    if (this.disposed) return;
    try {
      this.ensureGraph();
    } catch {
      this._pitchCorrection = false;
    }
    const dur = this.duration;
    if (dur > 0 && this.currentTime >= dur - 0.05) this.seek(0);
    this.alignToLead();
    for (const audio of this.elements.values()) {
      audio.playbackRate = this.tempo;
      this.unlock(audio);
    }
    this.playingFlag = true;
    const pending: Promise<void>[] = [];
    for (const audio of this.elements.values()) pending.push(audio.play());
    this.startDrift();
    this.kickRaf();
    this.emit();
    this.scheduleUnlock();
    void Promise.all(pending).catch(() => {
      if (this.disposed || this.anyPlaying()) return;
      this.playingFlag = false;
      this.stopDrift();
      this.stopRaf();
      this.emit();
    });
  }

  pause(): void {
    if (this.disposed || this.pausing) return;
    this.pausing = true;
    this.playingFlag = false;
    this.stopDrift();
    this.stopRaf();
    for (const audio of this.elements.values()) audio.pause();
    this.pausing = false;
    this.emit();
  }

  seek(seconds: number): void {
    if (this.disposed || !Number.isFinite(seconds)) return;
    const dur = this.duration;
    let time = Math.max(0, seconds);
    if (dur > 0) time = Math.min(time, dur);
    for (const audio of this.elements.values()) {
      if (audio.readyState >= 1) this.setTime(audio, time);
    }
    this.emit();
  }

  setStem(id: StemId, volume: number, mute: boolean, solo: boolean, anySolo: boolean): void {
    const level = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
    const gain = mute || (anySolo && !solo) ? 0 : level;
    this.wanted.set(id, gain);
    this.pushGain(id, gain);
  }

  setTempo(rate: number): void {
    if (!Number.isFinite(rate)) return;
    this.tempo = Math.min(1.5, Math.max(0.5, rate));
    for (const audio of this.elements.values()) {
      audio.playbackRate = this.tempo;
      this.unlock(audio);
    }
    this.applyPitch();
    this.scheduleUnlock();
  }

  subscribe(cb: (time: number) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(cb);
    this.safeCall(cb, this.currentTime);
    if (this.playingFlag) this.kickRaf();
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0) this.stopRaf();
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playingFlag = false;
    this.stopDrift();
    this.stopRaf();
    if (this.unlockFrame != null) {
      cancelAnimationFrame(this.unlockFrame);
      this.unlockFrame = null;
    }
    for (const audio of this.elements.values()) audio.pause();
    this.listeners.clear();
    const ctx = this.context;
    this.context = null;
    this.pitchNode = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => undefined);
  }

  private async loadAll(): Promise<void> {
    await Promise.all(STEM_IDS.map((id) => this.loadStem(id)));
  }

  private loadStem(id: StemId): Promise<void> {
    const audio = this.element(id);
    const url = this.urls[id] ?? "";
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        audio.removeEventListener("loadedmetadata", finish);
        audio.removeEventListener("error", finish);
        this.unlock(audio);
        this.emit();
        resolve();
      };
      audio.addEventListener("loadedmetadata", finish);
      audio.addEventListener("error", finish);
      audio.src = url;
      this.unlock(audio);
      if (audio.readyState >= 1) finish();
    });
  }

  private ensureGraph(): void {
    if (this.wired) {
      void this.context?.resume().catch(() => undefined);
      return;
    }
    const ctx = createAudioContext();
    this.context = ctx;
    const mix = ctx.createGain();
    mix.gain.value = 1;

    for (const id of STEM_IDS) {
      const audio = this.element(id);
      const source = ctx.createMediaElementSource(audio);
      const gain = ctx.createGain();
      gain.gain.value = this.wanted.get(id) ?? 1;
      source.connect(gain);
      gain.connect(mix);
      this.sources.push(source);
      this.gains.set(id, gain);
    }

    mix.connect(ctx.destination);
    this.wired = true;
    void ctx.resume().catch(() => undefined);

    const workletUrl = new URL("./pitch-correction.worklet.js", import.meta.url);
    void ctx.audioWorklet
      .addModule(workletUrl)
      .then(() => {
        if (this.disposed || this.context !== ctx) return;
        try {
          const node = new AudioWorkletNode(ctx, "pitch-correction", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: "explicit",
            channelInterpretation: "speakers",
          });
          mix.disconnect();
          mix.connect(node);
          node.connect(ctx.destination);
          this.pitchNode = node;
          this._pitchCorrection = true;
          this.applyPitch();
        } catch {
          this._pitchCorrection = false;
          try {
            mix.disconnect();
          } catch {
            /* The direct path may already be gone. */
          }
          try {
            mix.connect(ctx.destination);
          } catch {
            /* The context was closed while the worklet loaded. */
          }
        }
      })
      .catch(() => {
        this._pitchCorrection = false;
      });
  }

  private applyPitch(): void {
    const param = this.pitchNode?.parameters.get("semitones");
    const ctx = this.context;
    if (!param || !ctx || ctx.state === "closed") return;
    param.setValueAtTime(-12 * Math.log2(this.tempo), ctx.currentTime);
  }

  private pushGain(id: StemId, gain: number): void {
    const node = this.gains.get(id);
    const ctx = this.context;
    if (!node || !ctx || ctx.state === "closed") return;
    const now = ctx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    node.gain.linearRampToValueAtTime(gain, now + 0.02);
  }

  private alignToLead(): void {
    const lead = this.element(this.leadId);
    if (lead.readyState < 1) return;
    const time = lead.currentTime;
    for (const id of STEM_IDS) {
      if (id === this.leadId) continue;
      const audio = this.element(id);
      if (audio.readyState < 1 || audio.seeking) continue;
      if (Math.abs(audio.currentTime - time) > DRIFT_LIMIT_SECONDS) this.setTime(audio, time);
    }
  }

  private startDrift(): void {
    if (this.driftTimer != null) return;
    this.driftTimer = setInterval(() => {
      if (!this.playingFlag) return;
      const lead = this.element(this.leadId);
      if (lead.readyState < 2 || lead.seeking) return;
      this.alignToLead();
    }, DRIFT_INTERVAL_MS);
  }

  private stopDrift(): void {
    if (this.driftTimer == null) return;
    clearInterval(this.driftTimer);
    this.driftTimer = null;
  }

  private kickRaf(): void {
    if (this.raf != null || !this.playingFlag || this.listeners.size === 0) return;
    const tick = () => {
      this.raf = null;
      if (!this.playingFlag || this.listeners.size === 0 || this.disposed) return;
      this.emit();
      if (this.playingFlag && this.listeners.size > 0) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopRaf(): void {
    if (this.raf == null) return;
    cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private emit(): void {
    const time = this.currentTime;
    for (const cb of [...this.listeners]) this.safeCall(cb, time);
  }

  private safeCall(cb: (time: number) => void, time: number): void {
    try {
      cb(time);
    } catch {
      /* One view should not stop the clock for the others. */
    }
  }

  private scheduleUnlock(): void {
    if (this.unlockFrame != null) return;
    this.unlockFrame = requestAnimationFrame(() => {
      this.unlockFrame = null;
      if (this.disposed) return;
      for (const audio of this.elements.values()) this.unlock(audio);
    });
  }

  private unlock(audio: HTMLAudioElement): void {
    const media = audio as HTMLAudioElement & { webkitPreservesPitch?: boolean };
    try {
      media.preservesPitch = false;
    } catch {
      /* WebKit can reject the write until the element has metadata. */
    }
    try {
      media.webkitPreservesPitch = false;
    } catch {
      /* Older WebKit builds omit the prefixed setter. */
    }
  }

  private setTime(audio: HTMLAudioElement, time: number): void {
    try {
      audio.currentTime = time;
    } catch {
      /* The element is not seekable yet. */
    }
  }

  private anyPlaying(): boolean {
    for (const audio of this.elements.values()) {
      if (!audio.paused && !audio.ended) return true;
    }
    return false;
  }

  private element(id: StemId): HTMLAudioElement {
    const audio = this.elements.get(id);
    if (!audio) throw new Error(`Unknown stem: ${id}`);
    return audio;
  }
}

function createAudioContext(): AudioContext {
  const legacy = window as Window & { webkitAudioContext?: typeof AudioContext };
  const Ctor = window.AudioContext ?? legacy.webkitAudioContext;
  if (!Ctor) throw new Error("AudioContext is unavailable");
  return new Ctor({ latencyHint: "interactive" });
}
