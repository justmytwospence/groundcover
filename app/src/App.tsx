import { useCallback, useEffect, useRef, useState } from 'react';
import { xToLng, yToLat } from '@um/ledger';
import { MapView, type MapHandles } from './map/MapView.js';
import { FilterPanel } from './panels/FilterPanel.js';
import { StatsCard } from './panels/StatsCard.js';
import { Legend } from './panels/Legend.js';
import { Scrubber } from './panels/Scrubber.js';
import { StatsDrawer } from './panels/StatsDrawer.js';
import { Setup } from './panels/Setup.js';
import { SearchBox, type Bounds } from './panels/SearchBox.js';
import { SitePopup } from './panels/SitePopup.js';
import { hydrateFromHash, readMapFromHash, startHashSync, useStore } from './state/store.js';
import type { QueryRequest, SiteInfoResult, TracksMessage, WorkerOut } from './worker/protocol.js';

interface HoverAt {
  lng: number;
  lat: number;
  radiusM: number;
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
  const [hover, setHover] = useState<HoverAt | null>(null);
  const hoverSeq = useRef(0);
  const [siteInfo, setSiteInfo] = useState<SiteInfoResult | null>(null);
  const [pinned, setPinned] = useState<{ info: SiteInfoResult; x: number; y: number } | null>(null);
  const pickSeq = useRef(0);
  const pickPoint = useRef<{ x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | undefined>(undefined);
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
        case 'siteInfoResult':
          if (msg.activities) {
            // A click asked for the full list.
            if (msg.seq !== pickSeq.current) break;
            setPinned(
              msg.siteIndex >= 0 && pickPoint.current
                ? { info: msg, x: pickPoint.current.x, y: pickPoint.current.y }
                : null,
            );
            break;
          }
          // A slower earlier hover lookup must not overwrite a newer one.
          if (msg.seq !== hoverSeq.current) break;
          setSiteInfo(msg.siteIndex >= 0 ? msg : null);
          mapRef.current?.setHovering(msg.siteIndex >= 0);
          break;
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

  // Ask the worker which site is under the cursor, debounced so sweeping the mouse across the
  // map does not queue a lookup per pixel.
  useEffect(() => {
    window.clearTimeout(hoverTimer.current);
    if (!hover) {
      setSiteInfo(null);
      mapRef.current?.setHovering(false);
      return;
    }
    hoverTimer.current = window.setTimeout(() => {
      const s = useStore.getState();
      workerRef.current?.postMessage({
        type: 'siteAt',
        lng: hover.lng,
        lat: hover.lat,
        radiusM: hover.radiusM,
        t0: s.t0,
        t1: s.t1,
        groups: s.groups,
        seq: ++hoverSeq.current,
      });
    }, 45);
    return () => window.clearTimeout(hoverTimer.current);
  }, [hover]);

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
        onHover={setHover}
        onPick={(at) => {
          const s = useStore.getState();
          pickPoint.current = { x: at.x, y: at.y };
          // Sequence numbers are shared with hover lookups, so a reply can be matched to
          // whichever request it answers.
          hoverSeq.current += 1;
          pickSeq.current = hoverSeq.current;
          workerRef.current?.postMessage({
            type: 'siteAt',
            lng: at.lng,
            lat: at.lat,
            radiusM: at.radiusM,
            t0: s.t0,
            t1: s.t1,
            groups: s.groups,
            seq: pickSeq.current,
            detail: true,
          });
        }}
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

          {pinned && (
            <SitePopup
              info={pinned.info}
              x={pinned.x}
              y={pinned.y}
              onClose={() => {
                setPinned(null);
                set({ activeActivity: null });
              }}
              onPreview={(idx) => set({ activeActivity: idx })}
            />
          )}

          {!pinned && hover && siteInfo && siteInfo.visits > 0 && (
            <div
              style={{
                position: 'absolute',
                left: Math.min(hover.x + 14, window.innerWidth - 250),
                top: hover.y + 14,
                background: 'rgba(12,14,18,0.94)',
                border: '1px solid var(--panel-border)',
                borderRadius: 6,
                padding: '7px 10px',
                pointerEvents: 'none',
                zIndex: 50,
                fontSize: 11,
                width: 232,
              }}
            >
              <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>
                {siteInfo.visits === 1 ? '1 pass' : `${siteInfo.visits} passes`}
                {siteInfo.visitsAllTime > siteInfo.visits && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11 }}>
                    {'  '}
                    {siteInfo.visitsAllTime} all time
                  </span>
                )}
              </div>

              {/* Directions can sum above the pass count: one out-and-back travels both ways. */}
              <div style={{ display: 'flex', gap: 10, margin: '4px 0 5px' }}>
                {[
                  { n: siteInfo.alongCount, label: siteInfo.alongLabel },
                  { n: siteInfo.againstCount, label: siteInfo.againstLabel },
                ]
                  .filter((d) => d.n > 0)
                  .map((d) => (
                    <span key={d.label} style={{ color: 'var(--text-secondary)' }}>
                      <span style={{ color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
                        {d.n}
                      </span>{' '}
                      heading {d.label}
                    </span>
                  ))}
              </div>

              <div style={{ color: 'var(--frontier)' }}>
                first covered {new Date(siteInfo.firstTs * 1000).toISOString().slice(0, 10)}
              </div>
              <div
                style={{
                  color: 'var(--text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {siteInfo.firstActivityName}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
