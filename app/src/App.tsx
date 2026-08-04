import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { xToLng, yToLat } from '@um/ledger';
import { MapView, type MapHandles } from './map/MapView.js';
import { FilterPanel } from './panels/FilterPanel.js';
import { StatsCard } from './panels/StatsCard.js';
import { Legend } from './panels/Legend.js';
import { Scrubber } from './panels/Scrubber.js';
import { StatsDrawer } from './panels/StatsDrawer.js';
import { Setup } from './panels/Setup.js';
import { SearchBox, type Bounds } from './panels/SearchBox.js';
import { hydrateFromHash, readMapFromHash, startHashSync, useStore } from './state/store.js';
import type { QueryRequest, TracksMessage, WorkerOut } from './worker/protocol.js';

interface HoverInfo {
  siteIndex: number;
  x: number;
  y: number;
}

export function App() {
  const store = useStore();
  const set = useStore((s) => s.set);
  const workerRef = useRef<Worker | null>(null);
  const mapRef = useRef<MapHandles | null>(null);
  const siteMeta = useRef<{ mintTs: Uint32Array; mintAct: Uint32Array } | null>(null);
  const tracks = useRef<TracksMessage | null>(null);
  /** The worker can finish loading before the map does, or after. Keep the geometry until
   *  both are ready, or the handoff is silently dropped and the map stays blank. */
  const readyGeom = useRef<{ src: Float32Array; dst: Float32Array; n: number; bounds: [number, number, number, number] } | null>(null);
  /** deck.gl keeps its attribute array across redraws, so it can never be handed a buffer we
   *  later transfer away -- a detached buffer renders nothing. Copy into a stable buffer the
   *  main thread owns outright, then hand the transferable straight back to the worker. */
  const stableColors = useRef<Uint8Array | null>(null);
  const colorVersion = useRef(0);
  const pending = useRef(false);
  const queued = useRef(false);
  const fitKey = useRef('');
  const [mapReady, setMapReady] = useState(false);
  const [tracksLoaded, setTracksLoaded] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [progress, setProgress] = useState(0);

  // ---- worker lifecycle ----------------------------------------------------------------
  useEffect(() => {
    const w = new Worker(new URL('./worker/query.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = w;

    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'progress':
          setProgress(msg.loaded);
          break;
        case 'ready': {
          hydrateFromHash(msg.manifest.timeRange.minTs, msg.manifest.timeRange.maxTs);
          siteMeta.current = { mintTs: msg.siteMintTs, mintAct: msg.siteMintAct };
          set({ load: 'ready', manifest: msg.manifest, activities: msg.activities });
          const b = msg.manifest.bounds;
          readyGeom.current = {
            src: msg.sourcePositions,
            dst: msg.targetPositions,
            n: msg.nSites,
            bounds: [b.minLng, b.minLat, b.maxLng, b.maxLat],
          };
          applyGeometry();
          break;
        }
        case 'result': {
          const incoming = new Uint8Array(msg.colors);
          if (!stableColors.current || stableColors.current.length !== incoming.length) {
            stableColors.current = new Uint8Array(incoming.length);
          }
          stableColors.current.set(incoming);
          w.postMessage({ type: 'release', slot: msg.slot, colors: msg.colors }, [msg.colors]);
          mapRef.current?.setColors(stableColors.current, ++colorVersion.current);
          set({
            stats: {
              distinctM: msg.distinctM,
              newM: msg.newM,
              totalM: msg.totalM,
              activityCount: msg.activityCount,
            },
            ...(msg.extras ? { extras: msg.extras } : {}),
          });
          pending.current = false;
          if (queued.current) {
            queued.current = false;
            runQuery();
          }
          break;
        }
        case 'tracks':
          tracks.current = msg;
          // A ref assignment cannot wake the effect that wants to draw the path, so flag it
          // in state: otherwise the first activity you select never gets an overlay.
          setTracksLoaded(true);
          break;
        case 'error':
          if (msg.kind === 'params-mismatch') set({ paramsWarning: msg.message });
          else set({ load: msg.kind === 'failed' ? 'failed' : msg.kind, loadError: msg.message });
          break;
      }
    };

    w.postMessage({ type: 'init' });
    return () => w.terminate();
  }, []);

  /** Hand the geometry to the map once both sides are ready, whichever arrives second. */
  const applyGeometry = useCallback(() => {
    const g = readyGeom.current;
    const m = mapRef.current;
    if (!g || !m) return;
    m.setGeometry(g.src, g.dst, g.n);
    // Only fit the data when the URL did not already carry a view. A bookmarked or shared
    // link must land where it says it lands (SPEC.md section 6.8).
    if (!readMapFromHash()) m.flyToBounds(g.bounds);
  }, []);

  // ---- querying ------------------------------------------------------------------------
  const runQuery = useCallback(() => {
    const w = workerRef.current;
    const s = useStore.getState();
    if (!w || s.load !== 'ready') return;
    if (pending.current) {
      queued.current = true;
      return;
    }
    pending.current = true;
    const req: QueryRequest = {
      type: 'query',
      t0: s.t0,
      t1: s.t1,
      groups: s.groups,
      viewport: s.viewportFilter ? (mapRef.current?.getViewport() ?? null) : null,
      mode: s.mode,
      drawer: s.drawerOpen,
      incremental: s.playing && s.windowMode === 'expanding',
    };
    w.postMessage(req);
  }, []);

  useEffect(() => {
    runQuery();
  }, [
    store.load,
    store.t0,
    store.t1,
    store.groups,
    store.mode,
    store.viewportFilter,
    store.drawerOpen,
    runQuery,
  ]);

  useEffect(() => startHashSync(() => mapRef.current?.getMapState() ?? null), []);

  // ---- fit the map to the data in the current selection ----------------------------------
  useEffect(() => {
    if (store.load !== 'ready' || !store.fitToSelection || !mapReady) return;
    // Only act when the SELECTION changed. Re-running on every render would fight the user's
    // own panning, and keying on the map's own state would feed back on itself.
    const key = `${Math.round(store.t0)}|${Math.round(store.t1)}|${store.groups.join(',')}`;
    if (fitKey.current === key) return;
    fitKey.current = key;

    const groupSet = new Set(store.groups);
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const a of store.activities) {
      if (a.startTs < store.t0 || a.startTs > store.t1 || !groupSet.has(a.group)) continue;
      if (a.bbox[0] < minLng) minLng = a.bbox[0];
      if (a.bbox[1] < minLat) minLat = a.bbox[1];
      if (a.bbox[2] > maxLng) maxLng = a.bbox[2];
      if (a.bbox[3] > maxLat) maxLat = a.bbox[3];
    }
    if (!Number.isFinite(minLng)) return;
    mapRef.current?.fitIfNeeded([minLng, minLat, maxLng, maxLat]);
  }, [
    store.load,
    store.fitToSelection,
    store.t0,
    store.t1,
    store.groups,
    store.activities,
    // The map can finish loading after the selection settles; without this the one chance to
    // fit is burned while mapRef is still null and the selection is never framed.
    mapReady,
  ]);

  const searchGo = useCallback(
    (bounds: Bounds, activityIdx: number | null) => {
      const s = useStore.getState();
      const patch: Partial<typeof s> = { activeActivity: activityIdx };

      if (activityIdx !== null) {
        const a = s.activities[activityIdx];
        // Flying to an activity outside the current window would land on empty ground: its
        // sites are filtered out. Widen the window just enough to include it.
        if (a && (a.startTs < s.t0 || a.startTs > s.t1)) {
          patch.t0 = Math.min(s.t0, a.startTs);
          patch.t1 = Math.max(s.t1, a.startTs);
          // Claim the fit key for the window we are about to set, so "fit to selection" does
          // not immediately yank the map back out to frame the whole widened range.
          fitKey.current = `${Math.round(patch.t0)}|${Math.round(patch.t1)}|${s.groups.join(',')}`;
        }
      }

      set(patch);
      mapRef.current?.flyToBounds(bounds);
    },
    [set],
  );

  // ---- keyboard ------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const s = useStore.getState();
      const step = (s.t1 - s.t0) * 0.1;
      if (e.code === 'Space') {
        e.preventDefault();
        set({ playing: !s.playing });
      } else if (e.key === 'ArrowRight') set({ t0: s.t0 + step, t1: s.t1 + step });
      else if (e.key === 'ArrowLeft') set({ t0: s.t0 - step, t1: s.t1 - step });
      else if (e.key.toLowerCase() === 'e') set({ mode: 'exploration' });
      else if (e.key.toLowerCase() === 'h') set({ mode: 'heatmap' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);

  // ---- active activity path (playback + drawer selection) --------------------------------
  useEffect(() => {
    const w = workerRef.current;
    if (store.activeActivity === null) {
      mapRef.current?.setActivePath(null);
      return;
    }
    if (!tracks.current) {
      w?.postMessage({ type: 'loadTracks' });
      return;
    }
    const t = tracks.current;
    const from = t.trackOffsets[store.activeActivity];
    const to = t.trackOffsets[store.activeActivity + 1];
    const path: Array<[number, number]> = [];
    for (let i = from; i < to; i++) path.push([xToLng(t.px[i] / 100), yToLat(t.py[i] / 100)]);
    mapRef.current?.setActivePath(path);
  }, [store.activeActivity, tracksLoaded]);

  const hoverText = useMemo(() => {
    if (!hover || !siteMeta.current) return null;
    const ts = siteMeta.current.mintTs[hover.siteIndex];
    const actIdx = siteMeta.current.mintAct[hover.siteIndex];
    const act = store.activities[actIdx];
    if (!ts) return null;
    return {
      date: new Date(ts * 1000).toISOString().slice(0, 10),
      name: act?.name ?? 'unknown activity',
    };
  }, [hover, store.activities]);

  if (store.load !== 'ready' && store.load !== 'loading') {
    return <Setup state={store.load} message={store.loadError} />;
  }

  return (
    <>
      <MapView
        onReady={(h) => {
          if (mapRef.current === h) return;
          mapRef.current = h;
          applyGeometry();
          runQuery();
          setMapReady(true);
        }}
        onViewportChange={() => {
          if (useStore.getState().viewportFilter) runQuery();
        }}
        onHover={(i, x, y) => setHover(i === null ? null : { siteIndex: i, x, y })}
      />

      {store.load === 'loading' && (
        <div className="panel" style={{ top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 260 }}>
          <h2>Loading</h2>
          <div style={{ color: 'var(--text-secondary)' }}>
            {(progress / 1e6).toFixed(1)} MB of artifacts
          </div>
        </div>
      )}

      {store.load === 'ready' && (
        <>
          <FilterPanel />
          <SearchBox onGo={searchGo} />
          <StatsCard />
          <Legend />
          <Scrubber />
          {store.drawerOpen && (
            <StatsDrawer
              extras={store.extras}
              onSelectActivity={(idx) => {
                set({ activeActivity: idx });
                const a = store.activities[idx];
                if (a) mapRef.current?.flyToBounds(a.bbox);
              }}
              onClose={() => set({ drawerOpen: false })}
            />
          )}

          {store.paramsWarning && (
            <div
              className="panel"
              style={{ top: 12, left: '50%', transform: 'translateX(-50%)', padding: '8px 14px' }}
            >
              <span style={{ color: 'var(--text-secondary)' }}>{store.paramsWarning}</span>
            </div>
          )}

          {hoverText && hover && (
            <div
              style={{
                position: 'absolute',
                left: hover.x + 14,
                top: hover.y + 14,
                background: 'rgba(12,14,18,0.94)',
                border: '1px solid var(--panel-border)',
                borderRadius: 6,
                padding: '6px 9px',
                pointerEvents: 'none',
                zIndex: 50,
                fontSize: 11,
                maxWidth: 240,
              }}
            >
              <div style={{ color: 'var(--frontier)' }}>first covered {hoverText.date}</div>
              <div style={{ color: 'var(--text-secondary)' }}>{hoverText.name}</div>
            </div>
          )}
        </>
      )}
    </>
  );
}
