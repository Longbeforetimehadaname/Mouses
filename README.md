# Mouses

Mouses is a phone-first stem player. Songs stay on the phone. Splitting runs in the browser on that phone, so leave the screen on Mouses until a song finishes.

## Run locally

```bash
cd web && npm i && npm run dev
```

Open http://localhost:5173/Mouses/

The dev server redirects `/` to the song library.

## Install on an iPhone

Once GitHub Pages is enabled for this repo (Settings → Pages → Source: GitHub Actions), open this site in Safari:

https://longbeforetimehadaname.github.io/Mouses/

Then Share → Add to Home Screen, and open Mouses from the home screen. The app runs on its own, without a Python server.

## Google Drive

`VITE_GOOGLE_CLIENT_ID` is optional. Copy `.env.example` to `.env` in the repo root and set it only if you want Google sign-in. Vite reads that file when the app is built or the dev server starts. When it is empty, sign-in is optional and the library already works on this phone. The app does not wait for Google.

GitHub Pages can use the same value from the `VITE_GOOGLE_CLIENT_ID` Actions secret. Leave the secret unset to publish the local-only app.

## Adding a song

Use Add and pick an MP3. Mouses saves it on the phone and splits it there. Keep Mouses open, with the screen awake, until the song status is Ready. Processing cards show the current stage and how far along the split is.
