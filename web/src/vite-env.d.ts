/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

declare module "../components/Mixer";
declare module "../components/LyricsView";
declare module "../components/ChordsView";
declare module "../pipeline/processSong";
declare module "../drive/auth";
