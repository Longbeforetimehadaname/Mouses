import { useState } from "react";
import { googleClientId, requestAccessToken } from "./gis";
import { syncWithDrive } from "./sync";
import { errorText } from "../library/format";

export function SyncPanel(props: {
  onClose: () => void;
  onSynced: () => Promise<void> | void;
}) {
  const clientId = googleClientId();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function sync() {
    if (!clientId || running) return;
    setRunning(true);
    setError(null);
    setMessage("Waiting for Google sign-in");
    try {
      const token = await requestAccessToken(clientId);
      const summary = await syncWithDrive(token, setMessage);
      setMessage(summary);
      await props.onSynced();
    } catch (caught) {
      setMessage(null);
      setError(errorText(caught, "Sync failed. Songs on this phone are unchanged."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="top">
        <button type="button" className="text-button" onClick={props.onClose} disabled={running}>
          Library
        </button>
        <h1>Sync</h1>
      </header>
      <main className="sync-body">
        <p>
          Songs stay on this phone either way. Sync copies them to a Mouses folder in your
          Google Drive and downloads songs that folder already has. The browser talks to
          Drive directly.
        </p>
        {clientId ? (
          <p>Mouses asks only for files it creates in Drive.</p>
        ) : (
          <p>
            Drive sync needs a Google OAuth client id. Set VITE_GOOGLE_CLIENT_ID to a Web
            client id when you build or run Mouses. The library on this phone keeps working
            in the meantime.
          </p>
        )}
        {message ? (
          <p className="status" role="status" aria-live="polite">
            {message}
          </p>
        ) : null}
        {error ? (
          <p className="error-banner" role="alert">
            {error}
          </p>
        ) : null}
      </main>
      {clientId ? (
        <div className="dock">
          <button type="button" className="add-button" onClick={() => void sync()} disabled={running}>
            {running ? "Syncing" : message ? "Sync again" : "Sync now"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
