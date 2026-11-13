const TOKEN_KEY = "mouses.drive.accessToken";
const PROFILE_KEY = "mouses.drive.profile";
const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  email?: string;
  name?: string;
}

interface TokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface TokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: TokenResponse) => void;
  error_callback?: (error: { type?: string; message?: string }) => void;
}

declare global {
  interface ImportMetaEnv {
    readonly VITE_GOOGLE_CLIENT_ID?: string;
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient?: (config: TokenClientConfig) => TokenClient;
          revoke?: (token: string, done: () => void) => void;
        };
      };
    };
  }
}

export function isDriveConfigured(): boolean {
  const clientId = clientIdFromEnv();
  return clientId !== null;
}

export function getAccessToken(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function getProfile(): { email?: string; name?: string } | null {
  try {
    const raw = sessionStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: string; name?: string };
    if (!parsed.email && !parsed.name) return null;
    return { email: parsed.email, name: parsed.name };
  } catch {
    return null;
  }
}

export function signOut(): void {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(PROFILE_KEY);
  } catch {
    token = null;
  }
  const revoke = window.google?.accounts?.oauth2?.revoke;
  if (token && revoke) {
    try {
      revoke(token, () => {});
    } catch {
      // The session token is already gone.
    }
  }
}

export function signIn(): Promise<void> {
  const clientId = clientIdFromEnv();
  if (!clientId) return Promise.reject(new Error("Google Drive is not configured"));
  return new Promise((resolve, reject) => {
    const start = () => {
      try {
        const oauth = window.google?.accounts?.oauth2;
        if (!oauth?.initTokenClient) {
          reject(new Error("Google Identity Services did not load"));
          return;
        }
        // iOS home-screen apps often block popups, so a redirect-based flow is
        // preferred when the GIS API allows it. initTokenClient has no ux_mode
        // (that belongs to initCodeClient), so this stays on the token popup.
        // requestAccessToken runs on the click stack when the script is already loaded.
        const config: TokenClientConfig = {
          client_id: clientId,
          scope: DRIVE_SCOPE,
          callback: (response) => {
            if (response.error || !response.access_token) {
              reject(new Error(response.error_description || response.error || "Google sign-in failed"));
              return;
            }
            try {
              sessionStorage.setItem(TOKEN_KEY, response.access_token);
              const profile = profileFromToken(response);
              if (profile) sessionStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
              else sessionStorage.removeItem(PROFILE_KEY);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
              return;
            }
            resolve();
          },
          error_callback: (error) => {
            reject(new Error(error.message || error.type || "Google sign-in failed"));
          },
        };
        const client = oauth.initTokenClient(config);
        client.requestAccessToken();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    if (window.google?.accounts?.oauth2?.initTokenClient) start();
    else loadGis().then(start).catch(reject);
  });
}

function clientIdFromEnv(): string | null {
  const value = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function profileFromToken(response: TokenResponse): { email?: string; name?: string } | null {
  if (!response.email && !response.name) return null;
  return { email: response.email, name: response.name };
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2?.initTokenClient) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (window.google?.accounts?.oauth2?.initTokenClient) resolve();
      else reject(new Error("Google Identity Services did not load"));
    };
    const fail = () => reject(new Error("Google Identity Services failed to load"));
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      if (existing.dataset.loaded === "true") {
        finish();
        return;
      }
      existing.addEventListener("load", () => {
        existing.dataset.loaded = "true";
        finish();
      }, { once: true });
      existing.addEventListener("error", fail, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = "true";
      finish();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
}

if (typeof document !== "undefined" && isDriveConfigured()) {
  const script = document.createElement("script");
  script.src = GIS_SRC;
  script.async = true;
  script.onload = () => {
    script.dataset.loaded = "true";
  };
  document.head.appendChild(script);
}
