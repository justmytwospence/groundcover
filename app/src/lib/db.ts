/**
 * The visitor's own storage. Everything about a person's history lives here, in their browser,
 * and nowhere else -- there is no server to send it to.
 *
 * Hand-rolled over raw IndexedDB rather than pulling in a wrapper: four stores and a handful of
 * operations do not justify a dependency, and the promise plumbing is contained in one file.
 */

export const DB_NAME = 'unique-miles';
export const DB_VERSION = 1;

/** Raw per-activity GPS, keyed on Strava activity id so API and ZIP imports merge cleanly. */
export const STORE_ACTIVITIES = 'activities';
/** Built ledger output: manifest, sites, touches, tracks, activities. */
export const STORE_ARTIFACTS = 'artifacts';
/** Sync cursor and per-activity fetch status, so an interrupted sync resumes. */
export const STORE_SYNC = 'syncState';
/** The user's own Strava app credentials and rotating tokens. */
export const STORE_CREDS = 'credentials';

/**
 * One activity's GPS, stored compactly. Boxed `[lat, lng]` pairs cost ~90 bytes per point;
 * these cost 14, which is the difference between a history fitting in a browser and not.
 * Coordinates are degrees x 1e7 (about 1.1 cm), well past GPS precision.
 */
export interface StoredActivity {
  id: number;
  name: string;
  startTs: number;
  startDateLocal: string;
  sportType: string;
  distanceM: number;
  trainer: boolean;
  manual: boolean;
  /** Where this came from, so the UI can explain a mixed history. */
  source: 'api' | 'zip';
  lat: Int32Array;
  lng: Int32Array;
  /** Seconds from activity start. */
  t: Int32Array;
  /** Metres; absent when the source had no elevation. */
  alt: Int16Array | null;
}

export const LAT_LNG_SCALE = 1e7;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ACTIVITIES)) {
        const s = db.createObjectStore(STORE_ACTIVITIES, { keyPath: 'id' });
        // The build must feed activities chronologically, so iterate this index directly.
        s.createIndex('byStart', 'startTs');
      }
      if (!db.objectStoreNames.contains(STORE_ARTIFACTS)) {
        db.createObjectStore(STORE_ARTIFACTS, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC)) db.createObjectStore(STORE_SYNC, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORE_CREDS)) db.createObjectStore(STORE_CREDS, { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
export function db(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = open();
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const d = await db();
  return done<T>(d.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T>);
}

export async function put(store: string, value: unknown): Promise<void> {
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).put(value as never);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Batch put, so writing a page of synced activities is one transaction rather than N. */
export async function putAll(store: string, values: unknown[]): Promise<void> {
  if (!values.length) return;
  const d = await db();
  const tx = d.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v as never);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function count(store: string): Promise<number> {
  const d = await db();
  return done(d.transaction(store, 'readonly').objectStore(store).count());
}

/** Every stored activity id, so a sync can skip what it already has. */
export async function activityIds(): Promise<Set<number>> {
  const d = await db();
  const keys = await done(
    d.transaction(STORE_ACTIVITIES, 'readonly').objectStore(STORE_ACTIVITIES).getAllKeys(),
  );
  return new Set(keys as number[]);
}

/**
 * Walk stored activities in chronological order, one at a time, so only one is ever live --
 * materialising them all is exactly what the ledger refactor exists to avoid.
 *
 * Deliberately NOT a held-open cursor. An IndexedDB transaction auto-commits as soon as the
 * event loop goes idle with no pending request, and a generator whose consumer awaits anything
 * (a progress paint, a postMessage) hands control back long enough for that to happen -- the
 * cursor then throws TransactionInactiveError partway through a long build. Reading the ordered
 * key list once and fetching each record in its own short transaction is immune to that.
 */
export async function* activitiesChronological(): AsyncGenerator<StoredActivity> {
  const d = await db();
  // getAllKeys() on the index returns primary keys already ordered by startTs.
  const ids = (await done(
    d.transaction(STORE_ACTIVITIES, 'readonly').objectStore(STORE_ACTIVITIES).index('byStart').getAllKeys(),
  )) as number[];
  for (const id of ids) {
    const a = await get<StoredActivity>(STORE_ACTIVITIES, id);
    if (a) yield a;
  }
}

export async function clearAll(): Promise<void> {
  const d = await db();
  const stores = [STORE_ACTIVITIES, STORE_ARTIFACTS, STORE_SYNC, STORE_CREDS];
  const tx = d.transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Bytes available, so a sync can warn before filling the disk rather than dying at 80%. */
export async function quota(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

/**
 * Ask the browser not to evict this origin's data.
 *
 * Must be called from a user gesture or Chrome declines without asking. Safari never grants it
 * at all and evicts after roughly seven days without a visit, which is why the answer is
 * returned rather than swallowed: a user whose entire history can silently disappear deserves
 * to be told, not reassured.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * True when the failure is the disk filling up rather than anything we did.
 *
 * Browsers disagree on how they say it: a DOMException named QuotaExceededError, code 22, or on
 * older WebKit a bare message. All three mean the same thing and need the same handling, so
 * they are recognised together.
 */
export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: number; message?: string };
  return (
    e.name === 'QuotaExceededError' ||
    e.code === 22 ||
    /quota|storage.*full|exceeded/i.test(e.message ?? '')
  );
}
