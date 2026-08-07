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
import { IS_PUBLISHED_BUILD } from '../worker/artifactSource.js';
import { isConnected } from './creds.js';
import { completeAuthorization } from './oauth.js';
import { runSync, type SyncProgress } from './sync.js';
import type { BuildReport } from '../panels/ImportReport.js';

export type ConnState = 'checking' | 'disconnected' | 'connected';

export interface Connection {
  state: ConnState;
  authError: string | null;
  sync: SyncProgress | null;
  building: boolean;
  /** What the last build left out. Null until one has run in this session. */
  report: BuildReport | null;
  dismissReport: () => void;
  /** Set when a build failed. Without this the failure is invisible and the map silently stale. */
  buildError: string | null;
  startSync: () => void;
  stopSync: () => void;
  dismissSync: () => void;
  /** Recompute the map from activities already downloaded. Costs no Strava requests. */
  rebuild: () => void;
  /** Called when authorization completed outside the redirect flow, from a pasted address. */
  markConnected: () => void;
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
  const [report, setReport] = useState<BuildReport | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);

  const abort = useRef<AbortController | null>(null);
  /** The in-flight sync itself, so `disconnect` can wait for it to actually stop. */
  const syncDone = useRef<Promise<unknown> | null>(null);
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
        if (res.type === 'done') {
          setReport({ seen: res.seen, included: res.activities, excluded: res.excluded });
          setBuildError(null);
          notify.current();
        } else if (res.type === 'error') {
          // Deliberately does NOT re-set `dirty`: a deterministic failure would spin this loop
          // forever. Surfacing it and offering a manual rebuild is the honest alternative to
          // retrying silently and leaving the map quietly stale.
          setBuildError(res.message);
        }
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

    const run = runSync({
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
    syncDone.current = run;
    void run;
  }, [drain]);

  const dismissReport = useCallback(() => setReport(null), []);
  const stopSync = useCallback(() => abort.current?.abort(), []);
  const dismissSync = useCallback(() => setSync(null), []);

  const rebuild = useCallback(() => {
    dirty.current = true;
    void drain();
  }, [drain]);

  const markConnected = useCallback(() => {
    setAuthError(null);
    setState('connected');
    startSync();
  }, [startSync]);

  const disconnect = useCallback(async () => {
    abort.current?.abort();
    // Wait for the sync to actually stop before erasing. Aborting only *requests* that it stop;
    // its cleanup still runs a final flush, and IndexedDB serialises that write strictly after
    // the clear transaction, so activities the user was promised were erased would land back on
    // disk -- with the page then reloading to the connect screen, where no erase control exists.
    await syncDone.current?.catch(() => {});
    await clearAll();
    setSync(null);
    setState('disconnected');
    // A full reload is the only way to be sure nothing derived from the old account survives
    // in a worker, a module-level cache, or the URL hash.
    window.location.replace(window.location.origin + window.location.pathname);
  }, []);

  useEffect(() => {
    // The publish deployment shows one fixed map and owns no credentials. Running the OAuth
    // completion here would leave `state` stuck on 'checking' behind a redirect that can never
    // arrive, and touching IndexedDB would let a visitor's own map from the BYO deployment
    // shadow the published one when both are served from the same origin.
    if (IS_PUBLISHED_BUILD) {
      setState('disconnected');
      return;
    }

    void (async () => {
      const result = await completeAuthorization();

      if (result.kind === 'error') setAuthError(result.message);
      if (result.kind === 'denied') {
        setAuthError('Strava sign-in was cancelled. Nothing was changed.');
      }

      const connected = result.kind === 'connected' || (await isConnected());
      setState(connected ? 'connected' : 'disconnected');

      // Arriving back from Strava means they just asked for this; start without a second click.
      if (result.kind === 'connected') startSync();
    })();
    // No cancellation flag. StrictMode's simulated unmount is not a real one, so discarding the
    // result on cleanup threw away the only invocation that actually saw the OAuth response --
    // which is how every auth error came to be silent in development.
  }, [startSync]);

  return {
    state, authError, sync, building, report, buildError,
    startSync, stopSync, dismissSync, dismissReport, rebuild, markConnected, disconnect,
  };
}
