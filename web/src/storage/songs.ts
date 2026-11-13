import { STEM_IDS, type SongMeta, type StemId } from "../types";

const DB_NAME = "mouses";
const STORE = "songs";
const DB_VERSION = 1;
const ROOT_DIR = "mouses";

const stemUrls = new Map<string, string>();

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This phone cannot store songs (IndexedDB is missing)."));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error ?? new Error("Could not open the song library."));
      };
    });
  }
  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Song library request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Song library write failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Song library write was aborted."));
  });
}

async function putSong(song: SongMeta): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(STORE, "readwrite");
  transaction.objectStore(STORE).put(song);
  await transactionDone(transaction);
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

async function privateRoot(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error("This phone cannot store songs (private file storage is missing).");
  }
  return navigator.storage.getDirectory();
}

async function songDirectory(id: string, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await privateRoot();
  const library = await root.getDirectoryHandle(ROOT_DIR, { create });
  return library.getDirectoryHandle(id, { create });
}

async function writeMp3(dir: FileSystemDirectoryHandle, name: string, data: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

async function readMp3(id: string, name: string): Promise<Blob> {
  const dir = await songDirectory(id, false);
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

function stemKey(id: string, stem: StemId): string {
  return `${id}/${stem}`;
}

function dropStemUrl(id: string, stem?: StemId): void {
  for (const [key, url] of stemUrls) {
    const matches = stem ? key === stemKey(id, stem) : key.startsWith(`${id}/`);
    if (!matches) continue;
    URL.revokeObjectURL(url);
    stemUrls.delete(key);
  }
}

function assertStem(stem: StemId): void {
  if (!STEM_IDS.includes(stem)) {
    throw new Error(`Unknown stem: ${stem}`);
  }
}

function titleFromFile(file: File): string {
  const stripped = file.name.replace(/\.mp3$/i, "").trim();
  return stripped || "Untitled";
}

export async function listSongs(): Promise<SongMeta[]> {
  const db = await openDb();
  const transaction = db.transaction(STORE, "readonly");
  const rows = await requestToPromise(transaction.objectStore(STORE).getAll() as IDBRequest<SongMeta[]>);
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSong(id: string): Promise<SongMeta | null> {
  const db = await openDb();
  const transaction = db.transaction(STORE, "readonly");
  const row = await requestToPromise(
    transaction.objectStore(STORE).get(id) as IDBRequest<SongMeta | undefined>,
  );
  return row ?? null;
}

export async function createSong(file: File): Promise<SongMeta> {
  const song: SongMeta = {
    id: crypto.randomUUID(),
    title: titleFromFile(file),
    duration: 0,
    status: "processing",
    progress: 0,
    stage: "Saved",
    bpm: 0,
    words: [],
    beats: [],
    createdAt: Date.now(),
  };
  const dir = await songDirectory(song.id, true);
  try {
    await writeMp3(dir, "original.mp3", file);
    await putSong(song);
  } catch (error) {
    await deleteSong(song.id).catch(() => undefined);
    throw error;
  }
  return song;
}

export async function updateSong(id: string, patch: Partial<SongMeta>): Promise<SongMeta> {
  const current = await getSong(id);
  if (!current) {
    throw new Error("Song not found");
  }
  const next: SongMeta = { ...current, ...patch, id: current.id };
  await putSong(next);
  return next;
}

export async function saveStem(id: string, stem: StemId, data: Blob): Promise<void> {
  assertStem(stem);
  dropStemUrl(id, stem);
  const dir = await songDirectory(id, true);
  await writeMp3(dir, `${stem}.mp3`, data);
}

export async function stemUrl(id: string, stem: StemId): Promise<string> {
  assertStem(stem);
  const key = stemKey(id, stem);
  const cached = stemUrls.get(key);
  if (cached) return cached;
  const blob = await readMp3(id, `${stem}.mp3`);
  const url = URL.createObjectURL(blob);
  stemUrls.set(key, url);
  return url;
}

export async function originalBlob(id: string): Promise<Blob> {
  return readMp3(id, "original.mp3");
}

export async function deleteSong(id: string): Promise<void> {
  dropStemUrl(id);
  try {
    const root = await privateRoot();
    const library = await root.getDirectoryHandle(ROOT_DIR);
    await library.removeEntry(id, { recursive: true });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const db = await openDb();
  const transaction = db.transaction(STORE, "readwrite");
  transaction.objectStore(STORE).delete(id);
  await transactionDone(transaction);
}
