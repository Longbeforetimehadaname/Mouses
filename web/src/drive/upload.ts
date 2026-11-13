import type { SongMeta } from "../types";
import { getAccessToken } from "./auth";

interface DriveFile {
  id?: string;
  name?: string;
}

interface DriveList {
  files?: DriveFile[];
}

export async function uploadSong(
  song: SongMeta,
  files: { name: string; blob: Blob }[],
): Promise<void> {
  const token = getAccessToken();
  if (!token) return;

  const folderId = await mousesFolder(token);
  const meta = {
    title: song.title,
    duration: song.duration,
    status: song.status,
    bpm: song.bpm,
    words: song.words,
    beats: song.beats,
  };
  const payload = [
    ...files,
    {
      name: "meta.json",
      blob: new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }),
    },
  ];
  for (const file of payload) {
    await uploadOne(token, folderId, file.name, file.blob);
  }
}

async function mousesFolder(token: string): Promise<string> {
  const q = "name = 'Mouses' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const listed = await driveJson<DriveList>(token, filesUrl({ q, fields: "files(id,name)", pageSize: "1", spaces: "drive" }));
  const existing = listed.files?.find((file) => typeof file.id === "string" && file.id.length > 0);
  if (existing?.id) return existing.id;

  const created = await driveJson<DriveFile>(token, "https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Mouses",
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  if (!created.id) throw new Error("Drive did not return a Mouses folder id");
  return created.id;
}

async function uploadOne(token: string, folderId: string, name: string, blob: Blob): Promise<void> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = `name = '${escaped}' and '${folderId}' in parents and trashed = false`;
  const listed = await driveJson<DriveList>(token, filesUrl({
    q,
    fields: "files(id,name)",
    pageSize: "1",
    spaces: "drive",
  }));
  const existing = listed.files?.find((file) => typeof file.id === "string");
  const metadata = existing?.id ? { name } : { name, parents: [folderId] };
  const fileId = existing?.id;
  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  await driveMultipart(token, url, fileId ? "PATCH" : "POST", metadata, blob, contentType(name, blob));
}

function filesUrl(params: Record<string, string>): string {
  return `https://www.googleapis.com/drive/v3/files?${new URLSearchParams(params).toString()}`;
}

async function driveMultipart(
  token: string,
  url: string,
  method: "POST" | "PATCH",
  metadata: Record<string, unknown>,
  blob: Blob,
  mime: string,
): Promise<void> {
  const boundary = `mouses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Drive upload failed (${response.status}): ${detail.slice(0, 300)}`);
  }
}

async function driveJson<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Drive request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return await response.json() as T;
}

function contentType(name: string, blob: Blob): string {
  if (blob.type) return blob.type;
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".mp3")) return "audio/mpeg";
  return "application/octet-stream";
}
