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
  fidelitySheet?: string | null;
  /** Shape of `report` at write time; see SCHEMA. Absent on pre-versioned rows. */
  v?: number;
}

const DB_NAME = 'glbforge-studio';
const STORE = 'assets';
const CAP = 40;
/**
 * Bump whenever `report`'s shape changes. Rehydration replays a stored report
 * into the Inspector verbatim — it is never re-analyzed — so a row written by
 * an older bundle can hand a newer Inspector a report missing fields it reads
 * unconditionally. That throws during render, which blanks the whole app on
 * every load and leaves no UI to clear the cache with: the Studio is bricked
 * for that browser until someone opens devtools. A row whose `v` does not
 * match is dropped on load instead. Losing a cached asset costs one re-drop;
 * the alternative cost the whole app.
 */
const SCHEMA = 1;

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
      tx.objectStore(STORE).put({ ...asset, v: SCHEMA });
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
    const usable = rows.filter((r) => r.v === SCHEMA);
    if (usable.length !== rows.length) {
      const tx = db.transaction(STORE, 'readwrite');
      for (const r of rows) if (r.v !== SCHEMA) tx.objectStore(STORE).delete(r.id);
    }
    db.close();
    return usable;
  } catch {
    return [];
  }
}
