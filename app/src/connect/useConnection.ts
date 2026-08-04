/**
 * Connection, sync and rebuild, as one state machine.
 *
 * The loop is: activities arrive -> the ledger is rebuilt -> the query worker reloads. Rebuilds
 * are self-throttling. A batch landing while a build is already running only marks the result
 * stale, so a fast connection cannot queue up a hundred builds; the next one starts when the
 * current one finishes and covers everything that arrived meanwhile.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { clearAll } from '../lib/db.js';
import type { BuildResponse } from '../worker/build.worker.js';
import { isConnected } from './creds.js';
import { completeAuthorization } from './oauth.js';
import { runSync, type SyncProgress } from './sync.js';

export type ConnState = 'checking' | 'disconnected' | 'connected';

export interface Connection {
  state: ConnState;
  authError: string | null;
  sync: SyncProgress | null;
  building: boolean;
  startSync: () => void;
  stopSync: () => void;
  dismissSync: () => void;
  /** Recompute the map from activities already downloaded. Costs no Strava requests. */
  rebuild: () => void;
  disconnect: () => Promise<void>;
}

function runBuild(): Promise<BuildResponse> {
  return new Promise((resolve) => {
    const w = new Worker(new URL('../worker/build.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<BuildResponse>) => {
      if (e.data.type === 'progress') return;
      w.terminate();
      resolve(e.data);
    };
    w.onerror = (e) => {
      w.terminate();
      resolve({ type: 'error', message: e.message || 'The build worker failed.' });
    };
    w.postMessage({ type: 'build' });
  });
}

export function useConnection(onArtifacts: () => void): Connection {
  const [state, setState] = useState<ConnState>('checking');
  const [authError, setAuthError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncProgress | null>(null);
  const [building, setBuilding] = useState(false);

  const abort = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const dirty = useRef(false);
  const syncing = useRef(false);
  // onArtifacts identity changes with every App render; a ref keeps the build loop from
  // capturing a stale one without making every caller memoise.
  const notify = useRef(onArtifacts);
  notify.current = onArtifacts;

  /** Rebuilds until nothing new has arrived, then tells the app to reload artifacts. */
  const drain = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setBuilding(true);
    try {
      while (dirty.current) {
        dirty.current = false;
        const res = await runBuild();
        if (res.type === 'done') notify.current();
      }
    } finally {
      busy.current = false;
      setBuilding(false);
    }
  }, []);

  const startSync = useCallback(() => {
    if (syncing.current) return;
    syncing.current = true;
    const ctrl = new AbortController();
    abort.current = ctrl;

    void runSync({
      signal: ctrl.signal,
      onProgress: setSync,
      onBatch: () => {
        dirty.current = true;
        void drain();
      },
    }).finally(() => {
      syncing.current = false;
      abort.current = null;
    });
  }, [drain]);

  const stopSync = useCallback(() => abort.current?.abort(), []);
  const dismissSync = useCallback(() => setSync(null), []);

  const rebuild = useCallback(() => {
    dirty.current = true;
    void drain();
  }, [drain]);

  const disconnect = useCallback(async () => {
    abort.current?.abort();
    await clearAll();
    setSync(null);
    setState('disconnected');
    // A full reload is the only way to be sure nothing derived from the old account survives
    // in a worker, a module-level cache, or the URL hash.
    window.location.replace(window.location.origin + window.location.pathname);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await completeAuthorization();
      if (cancelled) return;

      if (result.kind === 'error') setAuthError(result.message);
      if (result.kind === 'denied') {
        setAuthError('Strava sign-in was cancelled. Nothing was changed.');
      }

      const connected = result.kind === 'connected' || (await isConnected());
      if (cancelled) return;
      setState(connected ? 'connected' : 'disconnected');

      // Arriving back from Strava means they just asked for this; start without a second click.
      if (result.kind === 'connected') startSync();
    })();
    return () => {
      cancelled = true;
    };
  }, [startSync]);

  return { state, authError, sync, building, startSync, stopSync, dismissSync, rebuild, disconnect };
}
