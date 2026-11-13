import { useEffect, useRef, useState } from "react";

type DriveSession = { email?: string } | null;

type DriveAuth = {
  signIn?: () => void | Promise<void>;
  signOut?: () => void | Promise<void>;
  getSession?: () => Promise<DriveSession>;
};

type AccountMode = "local" | "checking" | "signin";

function clientId(): string {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? "";
}

export function AccountPage() {
  const driveId = clientId();
  const driveRef = useRef<DriveAuth | null>(null);
  const [mode, setMode] = useState<AccountMode>(driveId ? "checking" : "local");
  const [email, setEmail] = useState<string | null>(null);
  const [canSignOut, setCanSignOut] = useState(false);

  useEffect(() => {
    if (!driveId) return;
    let cancelled = false;

    void (async () => {
      try {
        // @ts-ignore Drive auth is owned by another branch and may be absent here.
        const drive = (await import("../drive/auth")) as DriveAuth;
        if (cancelled) return;
        if (typeof drive.signIn !== "function") {
          setMode("local");
          return;
        }
        driveRef.current = drive;
        setCanSignOut(typeof drive.signOut === "function");
        if (typeof drive.getSession === "function") {
          try {
            const session = await drive.getSession();
            if (!cancelled && session?.email) setEmail(session.email);
          } catch {
            // The redirect button still works if the saved session cannot be read.
          }
        }
        if (!cancelled) setMode("signin");
      } catch {
        if (!cancelled) setMode("local");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [driveId]);

  async function signIn() {
    const drive = driveRef.current;
    if (!drive || typeof drive.signIn !== "function") {
      setMode("local");
      return;
    }
    try {
      await drive.signIn();
    } catch {
      setMode("local");
    }
  }

  async function signOut() {
    const drive = driveRef.current;
    if (!drive?.signOut) return;
    try {
      await drive.signOut();
      setEmail(null);
    } catch {
      setMode("local");
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <p className="mark">Mouses</p>
        <h1>Account</h1>
      </header>
      <section className="account-card">
        <h2>Google Drive sync</h2>
        <p>
          Sign-in keeps a copy of your library in Google Drive so it can follow you to another
          phone. Splitting still runs on this phone. The button redirects to Google. It does not
          open a popup.
        </p>
        {mode === "checking" ? <p className="account-note">Checking Drive sign-in…</p> : null}
        {mode === "local" && !driveId ? (
          <p className="account-note">Sign-in is optional. Your library already works on this phone.</p>
        ) : null}
        {mode === "local" && driveId ? (
          <p className="account-note">
            Google Drive sign-in could not be loaded. Your library already works on this phone.
          </p>
        ) : null}
        {mode === "signin" ? (
          <div className="account-actions">
            {email ? <p className="account-note">Signed in as {email}</p> : null}
            <button type="button" className="sign-in" onClick={() => void signIn()}>
              Sign in with Google
            </button>
            {canSignOut ? (
              <button type="button" className="text-button" onClick={() => void signOut()}>
                Sign out
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
