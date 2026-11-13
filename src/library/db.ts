import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SplitResult } from "../contract";
import { captureStems, restoreStems } from "./audio";
import type { SongAudio, SongMeta, Tombstone } from "./types";

interface MousesDB extends DBSchema {
  songs: {
    key: string;
    value: SongMeta;
  };
  audio: {
    key: string;
    value: SongAudio;
  };
  tombstones: {
    key: string;
    value: Tombstone;
  };
}

const DB_NAME = "mouses";
const DB_VERSION = 1;

let databasePromise: Promise<IDBPDatabase<MousesDB>> | null = null;

function database(): Promise<IDBPDatabase<MousesDB>> {
  if (!databasePromise) {
    databasePromise = openDB<MousesDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("songs", { keyPath: "id" });
        db.createObjectStore("audio", { keyPath: "id" });
        db.createObjectStore("tombstones", { keyPath: "id" });
      },
    }).catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

export async function listSongs(): Promise<SongMeta[]> {
  const db = await database();
  const songs = await db.getAll("songs");
  songs.sort((a, b) => b.updatedAt - a.updatedAt);
  return songs;
}

export async function getSong(
  id: string,
): Promise<{ meta: SongMeta; audio: SongAudio } | null> {
  const db = await database();
  const meta = await db.get("songs", id);
  if (!meta) return null;
  const audio = await db.get("audio", id);
  if (!audio) return null;
  return { meta, audio };
}

export async function putSong(meta: SongMeta, audio: SongAudio): Promise<void> {
  if (meta.id !== audio.id) throw new Error("Song id mismatch.");
  const db = await database();
  const tx = db.transaction(["songs", "audio"], "readwrite");
  tx.objectStore("songs").put(meta);
  tx.objectStore("audio").put(audio);
  await tx.done;
}

export async function deleteSong(id: string): Promise<void> {
  const db = await database();
  const tx = db.transaction(["songs", "audio", "tombstones"], "readwrite");
  tx.objectStore("songs").delete(id);
  tx.objectStore("audio").delete(id);
  tx.objectStore("tombstones").put({ id, deletedAt: Date.now() });
  await tx.done;
}

export async function listTombstones(): Promise<Tombstone[]> {
  const db = await database();
  return db.getAll("tombstones");
}

export async function clearTombstone(id: string): Promise<void> {
  const db = await database();
  await db.delete("tombstones", id);
}

export async function setDriveFileId(id: string, driveFileId: string): Promise<void> {
  const db = await database();
  const tx = db.transaction("songs", "readwrite");
  const store = tx.objectStore("songs");
  const meta = await store.get(id);
  if (meta) store.put({ ...meta, driveFileId });
  await tx.done;
}

export async function saveSplitSong(input: {
  title: string;
  original: ArrayBuffer;
  originalType: string;
  result: SplitResult;
}): Promise<SongMeta> {
  const now = Date.now();
  const id = songId();
  const meta: SongMeta = {
    id,
    title: input.title,
    createdAt: now,
    updatedAt: now,
    durationSec: input.result.durationSec,
    bpm: input.result.bpm,
    lyrics: input.result.lyrics,
    chords: input.result.chords,
    originalType: input.originalType || "audio/mpeg",
  };
  const audio: SongAudio = {
    id,
    original: input.original,
    stems: captureStems(input.result.stems),
  };
  await putSong(meta, audio);
  await clearTombstone(id);
  return meta;
}

export async function loadPlayable(
  id: string,
): Promise<{ meta: SongMeta; result: SplitResult }> {
  const row = await getSong(id);
  if (!row) throw new Error("That song is no longer on this phone.");
  return {
    meta: row.meta,
    result: {
      stems: restoreStems(row.audio.stems),
      durationSec: row.meta.durationSec,
      bpm: row.meta.bpm,
      lyrics: row.meta.lyrics,
      chords: row.meta.chords,
    },
  };
}

// LAN dev (http://192.168.x.x) is not a secure context, so randomUUID is missing.
function songId(): string {
  const api = globalThis.crypto;
  if (api && typeof api.randomUUID === "function") return api.randomUUID();
  const bytes = new Uint8Array(16);
  if (api && typeof api.getRandomValues === "function") api.getRandomValues(bytes);
  else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) hex.push((bytes[i] ?? 0).toString(16).padStart(2, "0"));
  const id = hex.join("");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
