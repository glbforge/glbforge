/**
 * IndexedDB persistence for the in-browser engine: every ingested asset
 * (uploads, forges, optimizations, paid generations) survives reloads.
 * Capped to the most recent 40 assets to bound storage.
 */

export interface PersistedAsset {
  id: string;
  name: string;
  bytes: ArrayBuffer;
  parentId: string | null;
  report: unknown;
  ts: number;
}

const DB_NAME = 'glbforge-studio';
const STORE = 'assets';
const CAP = 40;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function persistAsset(asset: PersistedAsset): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(asset);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    // Prune beyond the cap, oldest first.
    const all = await loadAssets();
    if (all.length > CAP) {
      const excess = all.sort((a, b) => a.ts - b.ts).slice(0, all.length - CAP);
      const tx = db.transaction(STORE, 'readwrite');
      for (const a of excess) tx.objectStore(STORE).delete(a.id);
    }
    db.close();
  } catch { /* private browsing / quota — persistence is best-effort */ }
}

export async function loadAssets(): Promise<PersistedAsset[]> {
  try {
    const db = await open();
    const rows = await new Promise<PersistedAsset[]>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as PersistedAsset[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows;
  } catch {
    return [];
  }
}
