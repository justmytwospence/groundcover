/**
 * Where the query engine gets its artifacts.
 *
 * Three implementations, and which ones exist depends on the build:
 *
 *   idb        a visitor's own imported history. The only source in the BYO product.
 *   dev-http   the owner's locally-built files, served by the vite middleware. DEV only.
 *   published  the owner's artifacts, fetched from the blob store named at build time. Exists
 *              only in the publish build, where PUBLISH_POINTER is defined.
 *
 * Both non-idb sources are gated on build-time constants so Vite drops them entirely from the
 * bundle that does not use them. The BYO deployment therefore still has no code path that
 * fetches anyone's coverage over the network, which is the guarantee SPEC.md section 0 makes;
 * the publish deployment has no OAuth or IndexedDB path in return.
 */

import type { ActivitySummary, Manifest } from '@um/ledger';
import { get, STORE_ARTIFACTS } from '../lib/db.js';

export type BlockName = 'sites' | 'touches' | 'tracks';

/** Set only in the publish build. Undefined everywhere else, which is what erases the branch. */
const PUBLISH_POINTER = import.meta.env.VITE_PUBLISH_POINTER as string | undefined;

export const IS_PUBLISHED_BUILD = Boolean(PUBLISH_POINTER);

export interface ArtifactSource {
  readonly kind: 'idb' | 'dev-http' | 'published';
  manifest(): Promise<Manifest | null>;
  block(name: BlockName): Promise<ArrayBuffer>;
  activities(): Promise<ActivitySummary[]>;
}

/** What the cron function writes to current.json. See scripts/publish/store.ts. */
interface CurrentPointer {
  buildId: string;
  builtAt: string;
  manifest: Manifest;
  files: { sites: string; touches: string; tracks: string; activities: string };
}

interface ArtifactRecord {
  name: string;
  data: ArrayBuffer | Manifest | ActivitySummary[];
}

const idbSource: ArtifactSource = {
  kind: 'idb',
  async manifest() {
    const r = await get<ArtifactRecord>(STORE_ARTIFACTS, 'manifest');
    return (r?.data as Manifest) ?? null;
  },
  async block(name) {
    const r = await get<ArtifactRecord>(STORE_ARTIFACTS, name);
    if (!r) throw new Error(`artifact block "${name}" missing from storage`);
    return r.data as ArrayBuffer;
  },
  async activities() {
    const r = await get<ArtifactRecord>(STORE_ARTIFACTS, 'activities');
    return (r?.data as ActivitySummary[]) ?? [];
  },
};

/** Streams a URL into one buffer, reporting progress so the loading bar is determinate. */
async function fetchBuffer(url: string, onChunk: (n: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    onChunk(value.length);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

function devHttpSource(mf: Manifest, onChunk: (n: number) => void): ArtifactSource {
  return {
    kind: 'dev-http',
    async manifest() {
      return mf;
    },
    block(name) {
      return fetchBuffer(`/artifacts/${mf.files[name].path}`, onChunk);
    },
    activities() {
      return fetch(`/artifacts/${mf.files.activities.path}`).then(
        (r) => r.json() as Promise<ActivitySummary[]>,
      );
    },
  };
}

/**
 * The publish build's source: the pointer names immutable, per-build artifact URLs, so the big
 * blocks cache for a month while the pointer itself is re-read each visit to pick up a new
 * build. Fetched fresh rather than from cache for the same reason.
 */
function publishedSource(pointer: CurrentPointer, onChunk: (n: number) => void): ArtifactSource {
  return {
    kind: 'published',
    async manifest() {
      return pointer.manifest;
    },
    block(name) {
      return fetchBuffer(pointer.files[name], onChunk);
    },
    activities() {
      return fetch(pointer.files.activities).then((r) => r.json() as Promise<ActivitySummary[]>);
    },
  };
}

/**
 * Storage first, then -- in dev only -- the owner's local artifacts. Returns null when neither
 * has anything, which is the ordinary first-visit state, not an error.
 *
 * The publish build short-circuits both: it has one map to show and no browser-local history to
 * prefer over it, and reading IndexedDB first would mean a visitor who had previously used the
 * BYO deployment on the same origin saw their own map here instead.
 */
export async function pickSource(onChunk: (n: number) => void): Promise<ArtifactSource | null> {
  if (PUBLISH_POINTER) {
    const res = await fetch(PUBLISH_POINTER, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`could not read the published map: HTTP ${res.status}`);
    return publishedSource((await res.json()) as CurrentPointer, onChunk);
  }

  const stored = await idbSource.manifest().catch(() => null);
  if (stored) return idbSource;

  if (import.meta.env.DEV) {
    try {
      const res = await fetch('/artifacts/manifest.json');
      // A dev server with no local artifacts falls through to the SPA handler and returns
      // index.html with a 200, so check the content rather than trusting the status.
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
        return devHttpSource((await res.json()) as Manifest, onChunk);
      }
    } catch {
      // No local artifacts in dev is normal.
    }
  }
  return null;
}
