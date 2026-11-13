type TokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type TokenClient = {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
};

type TokenError = {
  type?: string;
  message?: string;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: TokenError) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

let gisPromise: Promise<void> | null = null;

export function googleClientId(): string | null {
  const value = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisPromise = null;
      reject(new Error("Could not load Google sign-in. Check your connection. Songs on this phone are unchanged."));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

export async function requestAccessToken(clientId: string): Promise<string> {
  await loadGoogleIdentity();
  const google = window.google;
  if (!google) throw new Error("Google sign-in did not load.");
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (response) => {
        if (response.access_token) {
          resolve(response.access_token);
          return;
        }
        reject(
          new Error(
            response.error_description ||
              response.error ||
              "Google sign-in was cancelled. Songs on this phone are unchanged.",
          ),
        );
      },
      error_callback: (error) => {
        reject(
          new Error(
            error.message ||
              "Google sign-in was closed before it finished. Allow pop-ups and try again.",
          ),
        );
      },
    });
    client.requestAccessToken();
  });
}
