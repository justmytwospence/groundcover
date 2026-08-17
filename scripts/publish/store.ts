/**
 * Blob storage for the published deployment. See SPEC.md section 0.
 *
 * TWO stores, deliberately:
 *
 *   PRIVATE  the rotating Strava refresh token, the activity summaries, and the raw GPS
 *            corpus. One person's streams at full resolution are their home address; a
 *            refresh token is a live credential. Neither may sit behind a URL whose only
 *            protection is being hard to guess.
 *   PUBLIC   the built artifacts, which are the thing being published on purpose, and which
 *            the browser fetches directly so the 58 MB never passes through a function.
 *
 * The split is enforced here rather than at the call sites: `privateStore` and `publicStore`
 * carry their own token and their own access level, so writing raw GPS to the public store
 * would mean passing the wrong object, not forgetting a flag.
 */

import { del, get, head, list, put } from '@vercel/blob';

export interface Store {
  readonly access: 'private' | 'public';
  readonly token: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

/** Raw GPS, summaries, and the refresh token. Never reachable without this token. */
export function privateStore(): Store {
  return { access: 'private', token: requireEnv('PRIVATE_BLOB_READ_WRITE_TOKEN') };
}

/** Built artifacts, served straight to the browser. */
export function publicStore(): Store {
  return { access: 'public', token: requireEnv('BLOB_READ_WRITE_TOKEN') };
}

export interface PutOptions {
  contentType?: string;
  /** Seconds. The SDK floor is 60; the default is a month. */
  cacheControlMaxAge?: number;
}

export async function putBlob(
  store: Store,
  pathname: string,
  body: Uint8Array | string,
  opts: PutOptions = {},
): Promise<string> {
  // The SDK takes a Buffer, not a bare Uint8Array. Wrapping the existing memory rather than
  // Buffer.from(bytes) avoids a second 30 MB copy inside a 2 GB function.
  const payload =
    typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  const res = await put(pathname, payload, {
    access: store.access,
    token: store.token,
    addRandomSuffix: false,
    allowOverwrite: true,
    // Large shards and artifacts upload in parallel parts and retry individually, so one
    // flaky part does not throw away a whole 30 MB upload inside a bounded function budget.
    multipart: typeof body !== 'string' && body.byteLength > 8 * 1024 * 1024,
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    ...(opts.cacheControlMaxAge !== undefined
      ? { cacheControlMaxAge: opts.cacheControlMaxAge }
      : {}),
  });
  return res.url;
}

/**
 * Reads a blob whole. `useCache: false` because every caller here is reading state it may
 * have written on a previous run: a cached read could hand back yesterday's refresh token,
 * which Strava has already rotated and invalidated.
 */
export async function getBlob(store: Store, pathname: string): Promise<Uint8Array | null> {
  const res = await get(pathname, {
    access: store.access,
    token: store.token,
    useCache: false,
  });
  if (!res || !res.stream) return null;
  const buf = await new Response(res.stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function getJson<T>(store: Store, pathname: string): Promise<T | null> {
  const bytes = await getBlob(store, pathname);
  if (!bytes) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

export async function putJson(store: Store, pathname: string, value: unknown, opts: PutOptions = {}): Promise<string> {
  return putBlob(store, pathname, JSON.stringify(value), {
    contentType: 'application/json',
    ...opts,
  });
}

/** The public URL of an existing blob, or null if it is not there. */
export async function blobUrl(store: Store, pathname: string): Promise<string | null> {
  try {
    return (await head(pathname, { token: store.token })).url;
  } catch {
    return null;
  }
}

export async function listPaths(store: Store, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ token: store.token, prefix, ...(cursor ? { cursor } : {}) });
    for (const b of page.blobs) out.push(b.pathname);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

export async function delPaths(store: Store, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await del(paths, { token: store.token });
}

// ---------------------------------------------------------------------------------------
// Fixed paths. Anything that both the seed script and the cron function touch lives here, so
// the two cannot drift into writing and reading different keys.
// ---------------------------------------------------------------------------------------

export const TOKEN_PATH = 'state/token.json';
export const SUMMARIES_PATH = 'state/summaries.json';
export const CURRENT_PATH = 'current.json';

/** What `state/token.json` holds. The access token is never stored: it lives six hours. */
export interface StoredToken {
  refreshToken: string;
  athleteId?: number;
  rotatedAt?: string;
}

export interface StoredSummary {
  id: number;
  name: string;
  sportType: string;
  startDate: string;
  startDateLocal: string;
  startTs: number;
  distance: number;
  trainer: boolean;
  manual: boolean;
}

export interface SummariesFile {
  activities: Record<string, StoredSummary>;
}

/** What the published app fetches first. Small, and the only blob with a short cache. */
export interface CurrentPointer {
  buildId: string;
  builtAt: string;
  manifest: unknown;
  files: { sites: string; touches: string; tracks: string; activities: string };
  /**
   * The publish-only start cutoff this build was made with (unix seconds), so a change to it
   * republishes on the next run instead of waiting for a day with new activities. Absent on
   * pointers written before the cutoff existed.
   */
  minStartTs?: number;
}
