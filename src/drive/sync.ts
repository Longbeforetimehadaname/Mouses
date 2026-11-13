import { errorText } from "../library/format";
import {
  clearTombstone,
  getSong,
  listSongs,
  listTombstones,
  putSong,
  setDriveFileId,
} from "../library/db";
import type { SongAudio, SongMeta, Tombstone } from "../library/types";
import { decodeSongFile, encodeSongFile, SONG_FILE_EXTENSION } from "./song-file";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_NAME = "Mouses";
const FOLDER_MIME = "application/vnd.google-apps.folder";

type DriveFile = {
  id?: string;
  name?: string;
  createdTime?: string;
  appProperties?: {
    mousesId?: string;
    updatedAt?: string;
    title?: string;
  };
};

type DriveList = {
  files?: DriveFile[];
  nextPageToken?: string;
};

class DriveRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DriveRequestError";
    this.status = status;
  }
}

export async function syncWithDrive(
  token: string,
  onStatus: (message: string) => void,
): Promise<string> {
  if (!token.trim()) throw new Error("Google did not return an access token.");
  onStatus("Finding your Mouses folder");
  const folderId = await ensureFolder(token);
  onStatus("Reading songs on Drive");
  const remote = await listSongFiles(token, folderId);
  const local = await listSongs();
  const tombstones = await listTombstones();
  const remoteBySongId = new Map<string, DriveFile>();

  for (const file of remote) {
    const songId = songIdFromFile(file);
    if (!songId || !file.id) continue;
    remoteBySongId.set(songId, file);
  }

  let uploaded = 0;
  let downloaded = 0;
  let removed = 0;
  const errors: string[] = [];

  for (const tomb of tombstones) {
    const file = remoteBySongId.get(tomb.id);
    if (!file?.id) continue;
    if (remoteUpdatedAt(file) > tomb.deletedAt) continue;
    onStatus("Removing a deleted song from Drive");
    try {
      await trashFile(token, file.id);
      remoteBySongId.delete(tomb.id);
      removed += 1;
    } catch (caught) {
      errors.push(errorText(caught, "Could not remove a song from Drive."));
    }
  }

  const localIds = new Set(local.map((song) => song.id));

  for (const song of local) {
    const file = remoteBySongId.get(song.id);
    const remoteUpdated = file ? remoteUpdatedAt(file) : -1;
    if (!file || song.updatedAt > remoteUpdated) {
      onStatus(`Uploading ${song.title}`);
      try {
        const full = await getSong(song.id);
        if (!full) continue;
        const driveId = await uploadSong(token, folderId, full.meta, full.audio, file?.id);
        await setDriveFileId(song.id, driveId);
        uploaded += 1;
      } catch (caught) {
        errors.push(`${song.title}: ${errorText(caught, "Upload failed.")}`);
      }
      continue;
    }
    if (file.id && remoteUpdated > song.updatedAt) {
      onStatus(`Downloading ${song.title}`);
      try {
        await downloadIntoLibrary(token, file, tombstones);
        downloaded += 1;
      } catch (caught) {
        errors.push(`${song.title}: ${errorText(caught, "Download failed.")}`);
      }
    }
  }

  for (const [songId, file] of remoteBySongId) {
    if (localIds.has(songId) || !file.id) continue;
    const tomb = tombstones.find((entry) => entry.id === songId);
    if (tomb && tomb.deletedAt >= remoteUpdatedAt(file)) continue;
    const label = file.appProperties?.title?.trim() || "a song from Drive";
    onStatus(`Downloading ${label}`);
    try {
      await downloadIntoLibrary(token, file, tombstones);
      downloaded += 1;
    } catch (caught) {
      errors.push(`${label}: ${errorText(caught, "Download failed.")}`);
    }
  }

  if (uploaded === 0 && downloaded === 0 && removed === 0 && errors.length === 0) {
    if (local.length === 0 && remoteBySongId.size === 0) {
      return "Nothing to sync yet. Add a song on this phone first.";
    }
    return "This phone already matches Drive.";
  }

  const summary = `Uploaded ${uploaded}, downloaded ${downloaded}, removed ${removed}.`;
  if (errors.length === 0) return summary;
  return `${summary} ${errors.join(" ")}`;
}

async function ensureFolder(token: string): Promise<string> {
  const params = new URLSearchParams({
    q: `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name, createdTime)",
    pageSize: "10",
    spaces: "drive",
  });
  const listed = await driveJson<DriveList>(token, `${DRIVE_API}/files?${params}`);
  const folders = (listed.files ?? [])
    .filter((file) => file.id)
    .sort((a, b) => (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
  const existing = folders[0]?.id;
  if (existing) return existing;

  const created = await driveJson<{ id?: string }>(token, `${DRIVE_API}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
  });
  if (!created.id) throw new Error("Drive did not create the Mouses folder.");
  return created.id;
}

async function listSongFiles(token: string, folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      spaces: "drive",
      fields: "nextPageToken, files(id, name, appProperties)",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await driveJson<DriveList>(token, `${DRIVE_API}/files?${params}`);
    files.push(...(page.files ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  return files.filter((file) => songIdFromFile(file));
}

async function uploadSong(
  token: string,
  folderId: string,
  meta: SongMeta,
  audio: SongAudio,
  existingId: string | undefined,
): Promise<string> {
  const media = encodeSongFile(meta, audio);
  const metadata = {
    name: `${meta.id}${SONG_FILE_EXTENSION}`,
    mimeType: "application/octet-stream",
    appProperties: {
      mousesId: meta.id,
      updatedAt: String(meta.updatedAt),
      title: meta.title.slice(0, 100),
    },
  };
  if (existingId) {
    try {
      return await uploadMultipart(token, existingId, metadata, media);
    } catch (caught) {
      if (!(caught instanceof DriveRequestError) || caught.status !== 404) throw caught;
    }
  }
  return uploadMultipart(token, null, { ...metadata, parents: [folderId] }, media);
}

async function uploadMultipart(
  token: string,
  fileId: string | null,
  metadata: Record<string, unknown>,
  media: Blob,
): Promise<string> {
  const boundary = "mouses_song_boundary";
  const head =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n`;
  const mid = `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const path = fileId
    ? `${DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`
    : `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`;
  const created = await driveJson<{ id?: string }>(token, path, {
    method: fileId ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: new Blob([head, mid, media, tail]),
  });
  if (!created.id) throw new Error("Drive did not return a file id.");
  return created.id;
}

async function downloadIntoLibrary(
  token: string,
  file: DriveFile,
  tombstones: Tombstone[],
): Promise<void> {
  if (!file.id) throw new Error("Drive song is missing an id.");
  const response = await fetch(
    `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!response.ok) throw await driveError(response);
  const decoded = decodeSongFile(await response.arrayBuffer());
  decoded.meta.driveFileId = file.id;
  await putSong(decoded.meta, decoded.audio);
  if (tombstones.some((tomb) => tomb.id === decoded.meta.id)) {
    await clearTombstone(decoded.meta.id);
  }
}

async function trashFile(token: string, fileId: string): Promise<void> {
  await driveJson(token, `${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}

function songIdFromFile(file: DriveFile): string | null {
  const fromProperty = file.appProperties?.mousesId;
  if (fromProperty && /^[\w.-]+$/.test(fromProperty)) return fromProperty;
  const name = file.name ?? "";
  if (!name.endsWith(SONG_FILE_EXTENSION)) return null;
  const id = name.slice(0, -SONG_FILE_EXTENSION.length);
  return /^[\w.-]+$/.test(id) ? id : null;
}

function remoteUpdatedAt(file: DriveFile): number {
  const raw = file.appProperties?.updatedAt;
  if (raw === undefined) return 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

async function driveJson<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error("Could not reach Google Drive. Songs on this phone are unchanged.");
  }
  if (!response.ok) throw await driveError(response);
  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function driveError(response: Response): Promise<DriveRequestError> {
  const detail = await response.text();
  if (response.status === 401 || response.status === 403) {
    return new DriveRequestError(
      response.status,
      "Google Drive refused the sign-in. Try syncing again.",
    );
  }
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    if (parsed.error?.message) {
      return new DriveRequestError(
        response.status,
        `Drive error (${response.status}): ${parsed.error.message}`,
      );
    }
  } catch {
    // Body was not JSON.
  }
  return new DriveRequestError(response.status, `Drive error (${response.status}).`);
}
