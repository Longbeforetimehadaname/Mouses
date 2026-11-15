# Mouses

Mouses is a phone home screen for songs. Add an MP3, split it into drums, vocals, bass, guitar, and the rest on the phone, then play the stems. Songs stay in IndexedDB on the device, so they are still there after a reload with no network. Google Drive sync is optional and runs in the browser.

There is no Python and no app server. `npm run build` writes a static site to `dist/`.

## Run

```sh
npm install
npm run dev
```

The dev server listens on `0.0.0.0:5173`. Open `http://localhost:5173` on the phone or computer.

```sh
npm run build
npm run preview
```

Preview serves the production build on `0.0.0.0:4173`.

Copy `.env.example` to `.env.local` when you want Drive sync:

```sh
VITE_GOOGLE_CLIENT_ID=your-web-client-id.apps.googleusercontent.com
```

## Songs on this phone

IndexedDB database `mouses` stores three object stores:

- `songs` — title, duration, bpm, lyrics, chords, timestamps, and the Drive file id
- `audio` — the original MP3 bytes and five stem buffers (float32 PCM, one buffer per channel)
- `tombstones` — ids removed on this phone, so a later sync can delete that Drive copy when it has not changed since

Opening a song rebuilds `AudioBuffer`s from the saved channels. Clearing site data in the browser removes the library.

## Google Drive

Sync uses [Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/use-token-model) and Drive API v3. The OAuth client id is `VITE_GOOGLE_CLIENT_ID`. When that variable is missing or blank, the library still works and the Sync screen explains that an id is required.

Create a Google Cloud OAuth client of type **Web application**, enable the Drive API, and add the site origin (for local dev, `http://localhost:5173`) as an authorized JavaScript origin. The token request uses scope `https://www.googleapis.com/auth/drive.file`, so Mouses only sees files it created. No client secret and no backend are involved.

Sync uploads and downloads song files in a Drive folder named `Mouses`. Each song is one `.mousesong` file: a short JSON header plus the original bytes and stem PCM. A song removed on this phone is trashed in Drive on the next sync when the Drive copy is not newer.

## Pipeline and player

The phone app calls `splitMp3` from `src/pipeline/split.ts` and renders `Player` from `src/player/Player.tsx`. Those are the real modules: Spleeter stem separation, Whisper, and chord detection in the browser, and the stem mixer with synced lyrics and a 4/4 chord grid.

`npm run dev` and `npm run build` generate temporary stubs at those paths only when the real files are absent, then the build deletes stubs that still carry the `@mouses-temporary-stub` marker. `.gitignore` lists the two paths so a stub left behind is not committed. Tracked files stay tracked; the script does not overwrite a file that lacks the marker.

`splitMp3` matches `SplitMp3` in `src/contract.ts`. The shell calls it with a copy of the MP3 `ArrayBuffer` and renders `SplitProgress` (`stage`, `fraction` from 0 to 1) while it runs.

`Player` is a named export and receives:

```tsx
<Player
  title={title}
  stems={result.stems}
  durationSec={result.durationSec}
  bpm={result.bpm}
  lyrics={result.lyrics}
  chords={result.chords}
  onBack={() => setActive(null)}
/>
```

`src/contract.ts` is the shared data API. Stem ids are `drums`, `vocals`, `bass`, `guitar`, and `rest`.

## Stack

Vite, React, and TypeScript. `vite-plugin-pwa` makes an installable standalone web app (safe areas, large touch targets, offline shell). `idb` wraps IndexedDB. `onnxruntime-web` 1.31.1 runs four Spleeter U-Nets (vocals, drums, bass, other) on WASM, one thread, with no GPU. The bass stem is the bass network's output, including the fp32 bass graph so loud notes are not dropped. Guitar and rest split what the model calls other. `@huggingface/transformers` 4.3.2 runs quantized Whisper base for word-timed lyrics, and words that do not sit on the vocal are left out. There is no Python and no app server.

## Earlier phone UI

`web/` is an earlier phone UI, with its own `package.json`. GitHub Actions in `.github/workflows/pages.yml` builds that folder for GitHub Pages. The phone app is the repository root.
