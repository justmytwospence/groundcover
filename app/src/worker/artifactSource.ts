/**
 * Where the query engine gets its artifacts.
 *
 * Two implementations: IndexedDB (what a visitor's own imported history uses, and the only one
 * that exists in production) and a dev-only HTTP source for the owner's locally-built files.
 * The HTTP source is gated on import.meta.env.DEV so Vite drops it from a production bundle
 * entirely -- a deployed build has no code path that fetches anyone's coverage over the network.
 */

import type { ActivitySummary, Manifest } from '@um/ledger';
import { get, STORE_ARTIFACTS } from '../lib/db.js';

export type BlockName = 'sites' | 'touches' | 'tracks';

export interface ArtifactSource {
  readonly kind: 'idb' | 'dev-http';
  manifest(): Promise<Manifest | null>;
  block(name: BlockName): Promise<ArrayBuffer>;
  activities(): Promise<ActivitySummary[]>;
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
 * Storage first, then -- in dev only -- the owner's local artifacts. Returns null when neither
 * has anything, which is the ordinary first-visit state, not an error.
 */
export async function pickSource(onChunk: (n: number) => void): Promise<ArtifactSource | null> {
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
