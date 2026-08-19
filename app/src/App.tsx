import { useCallback, useEffect, useRef, useState } from 'react';
import { xToLng, yToLat, type ActivitySummary } from '@um/ledger';
import { MapView, type MapHandles } from './map/MapView.js';
import { FilterPanel } from './panels/FilterPanel.js';
import { StatsCard } from './panels/StatsCard.js';
import { Scrubber } from './panels/Scrubber.js';
import { StatsDrawer } from './panels/StatsDrawer.js';
import { SearchBox, type Bounds } from './panels/SearchBox.js';
import { SitePopup } from './panels/SitePopup.js';
import { AccountPanel } from './panels/AccountPanel.js';
import { ImportReport } from './panels/ImportReport.js';
import { SmallScreen } from './panels/SmallScreen.js';
import { ThemeToggle } from './panels/ThemeToggle.js';
import { SharePanel } from './panels/SharePanel.js';
import { ConnectFlow } from './connect/ConnectFlow.js';
import { SyncRibbon } from './connect/SyncRibbon.js';
import { useConnection } from './connect/useConnection.js';
import { IS_PUBLISHED_BUILD } from './worker/artifactSource.js';
import { PublishedFooter } from './panels/PublishedFooter.js';
import {
  hydrateFromHash,
  readInitialView,
  startHashListener,
  startHashSync,
  useStore,
} from './state/store.js';
import type { QueryRequest, SiteInfoResult, TracksMessage, WorkerOut } from './worker/protocol.js';

/**
 * Below this many activities still to fetch, a sync is a routine top-up and the map is left
 * alone. Above it, the run is long enough that watching something happen is worth more than an
 * undisturbed view.
 */
const LIVE_PREVIEW_MIN_ACTIVITIES = 40;

const DAY = 86400;

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
  /** Bumped when a rebuild lands. Tearing the query worker down and starting a fresh one is the
   *  whole reload: a new worker re-reads storage from scratch, so there is no partial-update
   *  path through the engine that could leave stale sites alongside new ones. */
  const [reloadKey, setReloadKey] = useState(0);
  const conn = useConnection(useCallback(() => setReloadKey((k) => k + 1), []));
  /** Lets an already-rendering map reach the connect flow on demand -- the local pipeline
   *  produces a "ready" map in a browser that has never connected to anything. */
  const [showConnect, setShowConnect] = useState(false);
  const [showShare, setShowShare] = useState(false);
  /** Whether the live preview has already been started for the sync currently running. */
  const previewStarted = useRef(false);
  /** The most work this sync ever had left, which is what decides if it is worth previewing. */
  const previewPeak = useRef(0);

  // ---- worker lifecycle ----------------------------------------------------------------
  useEffect(() => {
    // Everything derived from the previous worker's build is now wrong, and none of it clears
    // itself. `pending` is only ever cleared by a `result` message, so terminating a worker
    // mid-query latched it true forever -- after which every query returned early and the map
    // silently stopped responding to the scrubber, the filters and the mode toggle, while
    // tooltips kept working so it still looked alive. `tracks` is indexed by activity position,
    // and positions shift whenever a backfill inserts older activities, so a stale copy draws
    // one activity's route under another's name.
    pending.current = false;
    queued.current = false;
    stableColors.current = null;
    tracks.current = null;
    setTracksLoaded(false);

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
          // One pass to learn each activity's minting span. The transport needs it to pace a
          // route's draw, and this is the only place the per-site arrays are in hand.
          {
            const n = msg.activities.length;
            const spans = new Float64Array(2 * n);
            for (let i = 0; i < n; i++) {
              spans[2 * i] = Infinity;
              spans[2 * i + 1] = -Infinity;
            }
            const ts = msg.siteMintTs;
            const act = msg.siteMintAct;
            for (let i = 0; i < ts.length; i++) {
              const a = act[i];
              if (a >= n) continue;
              if (ts[i] < spans[2 * a]) spans[2 * a] = ts[i];
              if (ts[i] > spans[2 * a + 1]) spans[2 * a + 1] = ts[i];
            }
            useStore.setState({ actSpans: spans });
          }
          set({ load: 'ready', manifest: msg.manifest, activities: msg.activities });
          const b = msg.manifest.bounds;
          readyGeom.current = {
            src: msg.sourcePositions,
            dst: msg.targetPositions,
            n: msg.nSites,
            bounds: [b.minLng, b.minLat, b.maxLng, b.maxLat],
          };
          applyGeometry();
          runQuery();
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
            maxVisit: msg.maxVisit,
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
  }, [reloadKey]);

  /**
   * The map's extent in degrees, for the transport to compare activity bounding boxes against.
   * Published on load as well as on every move, or "skip out of view" would do nothing until
   * the first pan.
   */
  const publishViewBounds = useCallback(() => {
    const vp = mapRef.current?.getViewport();
    if (!vp) return;
    const lngs = [xToLng(vp.minX / 100), xToLng(vp.maxX / 100)];
    const lats = [yToLat(vp.minY / 100), yToLat(vp.maxY / 100)];
    useStore.setState({
      viewBounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    });
  }, []);

  /**
   * Bounding box of the activities inside a window, or null when the window holds none.
   *
   * Shared by "fit to selection" and by the initial framing of a link that carries a time frame
   * but no camera, so both mean the same thing by "the selection".
   */
  const selectionBounds = useCallback(
    (t0: number, t1: number, groups: number[], activities: ActivitySummary[]): Bounds | null => {
      const groupSet = new Set(groups);
      let minLng = Infinity;
      let minLat = Infinity;
      let maxLng = -Infinity;
      let maxLat = -Infinity;
      for (const a of activities) {
        if (a.startTs < t0 || a.startTs > t1 || !groupSet.has(a.group)) continue;
        if (a.bbox[0] < minLng) minLng = a.bbox[0];
        if (a.bbox[1] < minLat) minLat = a.bbox[1];
        if (a.bbox[2] > maxLng) maxLng = a.bbox[2];
        if (a.bbox[3] > maxLat) maxLat = a.bbox[3];
      }
      return Number.isFinite(minLng) ? [minLng, minLat, maxLng, maxLat] : null;
    },
    [],
  );

  /** Hand the geometry to the map once both sides are ready, whichever arrives second. */
  const applyGeometry = useCallback(() => {
    const g = readyGeom.current;
    const m = mapRef.current;
    if (!g || !m) return;
    m.setGeometry(g.src, g.dst, g.n);
    // A link naming a camera is already there -- the map was built at it -- and flying anywhere
    // now would discard what the link said (SPEC.md section 6.8).
    if (readInitialView()) return;
    // Otherwise frame what the link is about: a shared time frame gets the ground that window
    // covers, which is the extent the animation plays over. No window means everything.
    const s = useStore.getState();
    m.flyToBounds(selectionBounds(s.t0, s.t1, s.groups, s.activities) ?? g.bounds);
  }, [selectionBounds]);

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
      // Running backwards, the playhead is the window's floor and everything above it is
      // already drawn; running forwards it is the ceiling. Either way the fold sees exactly the
      // activities that should be on screen.
      t0: s.replayReverse && s.playhead !== null ? s.playhead : s.t0,
      t1: s.replayReverse ? s.t1 : (s.playhead ?? s.t1),
      reverse: s.replayReverse && s.playing,
      // Frozen at whatever the scale was when play began, so the ramp stops moving underneath
      // the ground it has already painted.
      scaleMax: s.playing ? s.maxVisit : undefined,
      groups: s.groups,
      viewport: s.viewportFilter ? (mapRef.current?.getViewport() ?? null) : null,
      mode: s.mode,
      theme: s.theme,
      playing: s.playing,
      drawer: s.drawerOpen,
      incremental: s.playing,
    };
    w.postMessage(req);
  }, []);

  useEffect(() => {
    runQuery();
  }, [
    store.load,
    store.t0,
    store.t1,
    store.playhead,
    store.replayReverse,
    store.groups,
    store.mode,
    store.viewportFilter,
    store.drawerOpen,
    // The colour buffer is built in the worker from the active palette, so a surface change is
    // a re-query, not a CSS repaint. Without this the map keeps the previous theme's ramp.
    store.theme,
    store.playing,
    store.speed,
    runQuery,
  ]);

  useEffect(() => startHashSync(() => mapRef.current?.getBounds() ?? null), []);

  // Pasting a link into this tab's address bar should move the map, not just the address.
  useEffect(
    () =>
      startHashListener((v) => {
        const m = mapRef.current;
        if (!m) return;
        if (v?.kind === 'bounds') {
          m.flyToBounds(v.bounds);
          return;
        }
        // No camera in the link: frame the window it just applied, the same as a cold load
        // would. Without this the address bar and the selection move and the map does not,
        // which is the exact symptom this listener exists to remove.
        const s = useStore.getState();
        const bb = selectionBounds(s.t0, s.t1, s.groups, s.activities);
        if (bb) m.flyToBounds(bb);
      }),
    [selectionBounds],
  );

  /**
   * Replay the history on a loop while a big backfill runs.
   *
   * A progress bar proves the code is running; watching your own map redraw itself proves the
   * right thing is arriving. The replay widens with each batch, so it doubles as progress.
   *
   * Deliberately drives the ordinary transport rather than adding a bespoke loop mode: handing
   * it an all-time selection and setting `playing` is exactly what pressing play does, which is
   * the path already covered by the rest of the app.
   */
  const syncPhase = conn.sync?.phase;
  const syncRemaining = conn.sync?.remaining ?? 0;
  useEffect(() => {
    const running =
      syncPhase === 'starting' ||
      syncPhase === 'summaries' ||
      syncPhase === 'streams' ||
      syncPhase === 'waiting';

    if (running) {
      // The PEAK, not the current value. There is nothing to preview until the first rebuild
      // makes a map exist, and by then a chunk of the queue has already been fetched -- so
      // comparing what is left at that moment against the threshold would reject every sync
      // whose first batch brought it under, which on a short run is all of them.
      previewPeak.current = Math.max(previewPeak.current, syncRemaining);

      if (
        store.load === 'ready' &&
        !previewStarted.current &&
        previewPeak.current >= LIVE_PREVIEW_MIN_ACTIVITIES
      ) {
        previewStarted.current = true;
        set({ t0: store.minTs, t1: store.maxTs + DAY, playhead: null, replayReverse: true, playing: true });
        return;
      }

      // A completed pass restarts, widened by whatever arrived meanwhile, so the replay lasts
      // as long as the download does. Only a run that reached the end qualifies -- a pause
      // leaves the window short of it, which is how the pause button stays honest.
      if (previewStarted.current && !store.playing) {
        set({ t0: store.minTs, t1: store.maxTs + DAY, playhead: null, replayReverse: true, playing: true });
      }
      return;
    }

    previewPeak.current = 0;
    if (previewStarted.current) {
      previewStarted.current = false;
      // Hand the map back whole rather than leaving it frozen on whatever frame the loop was on.
      set({
        playing: false,
        playhead: null,
        replayReverse: false,
        t0: useStore.getState().minTs,
        t1: useStore.getState().maxTs + DAY,
      });
    }
  }, [syncPhase, syncRemaining, store.load, store.playing, store.t1, store.minTs, store.maxTs, set]);

  // ---- fit the map to the data in the current selection ----------------------------------
  useEffect(() => {
    if (store.load !== 'ready' || !store.fitToSelection || !mapReady) return;

    // Only act when the SELECTION changed. Re-running on every render would fight the user's
    // own panning, and keying on the map's own state would feed back on itself.
    // What the map should frame: the replay's reach while it is running, the selection
    // otherwise. Keying on the selection alone would never refit during playback now that the
    // selection stays put, which would quietly make "also while playing" do nothing.
    const upper = store.playhead ?? store.t1;
    const key = `${Math.round(store.t0)}|${Math.round(upper)}|${store.groups.join(',')}`;

    // Playback advances continuously; refitting each step makes the map lurch and hides the
    // very thing playback exists to show. The key is still recorded while skipping, so that
    // when playback stops the accumulated movement is not mistaken for a fresh selection and
    // answered with one last jump.
    if (store.playing && !store.fitWhilePlaying) {
      fitKey.current = key;
      return;
    }

    if (fitKey.current === key) return;
    fitKey.current = key;

    const bb = selectionBounds(store.t0, upper, store.groups, store.activities);
    if (bb) mapRef.current?.fitIfNeeded(bb);
  }, [
    store.load,
    store.fitToSelection,
    store.fitWhilePlaying,
    store.playing,
    store.t0,
    store.t1,
    store.playhead,
    store.replayReverse,
    store.groups,
    store.activities,
    selectionBounds,
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

  // Order matters here. Existing artifacts always win: they mean there is a map to show, which
  // is true both for a returning visitor and for local development against files built by the
  // Node pipeline, where nothing was ever "connected" in this browser at all. Only once we know
  // there is nothing to draw does the question of connecting arise.
  // No `progress > 0` guard. In the BYO build that byte counter is fed only by the dev-only
  // HTTP artifact source, so the card it gated was unreachable for every real visitor -- who
  // instead got an unbranded dark rectangle for however long it took to read tens of megabytes
  // out of IndexedDB and rebuild the geometry. The publish build does feed it, over the network.
  if (conn.state === 'checking' || store.load === 'loading') {
    return (
      <>
        <ThemeToggle floating />
        <div className="connect-scroll">
        <div className="connect-card" style={{ margin: 'auto', textAlign: 'center' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 15 }}>
            {IS_PUBLISHED_BUILD ? 'Loading the map' : 'Loading your map'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 6 }}>
            {progress > 0
              ? `${(progress / 1e6).toFixed(1)} MB`
              : IS_PUBLISHED_BUILD
                ? 'Fetching coverage'
                : 'Reading it back out of this browser'}
          </div>
        </div>
        </div>
      </>
    );
  }

  if (store.load === 'failed' || store.load === 'format-mismatch') {
    return (
      <>
        <ThemeToggle floating />
        <div className="connect-scroll">
        <div className="connect-card" style={{ margin: 'auto' }}>
          <h1 className="connect-title" style={{ fontSize: 24 }}>
            {IS_PUBLISHED_BUILD ? 'This map could not be loaded' : 'Your stored map could not be read'}
          </h1>
          {/* Nothing a visitor to the published map can do about it, so do not offer them a
              control that spends their time and cannot help. */}
          <p className="connect-lede">
            {store.loadError}
            {IS_PUBLISHED_BUILD
              ? ' It is rebuilt nightly; try again shortly.'
              : ' Rebuilding from the activities already downloaded usually fixes it, and costs no Strava requests.'}
          </p>
          {!IS_PUBLISHED_BUILD && (
            <button className="ghost" onClick={conn.rebuild}>
              Rebuild
            </button>
          )}
        </div>
        </div>
      </>
    );
  }

  if (!IS_PUBLISHED_BUILD && (showConnect || (store.load !== 'ready' && conn.state === 'disconnected'))) {
    return (
      <>
        <ThemeToggle floating />
        <ConnectFlow
          error={conn.authError}
          onConnected={() => {
            setShowConnect(false);
            conn.markConnected();
          }}
        />
      </>
    );
  }

  return (
    <>
      <SmallScreen />
      <MapView
        onReady={(h) => {
          if (mapRef.current === h) return;
          mapRef.current = h;
          applyGeometry();
          runQuery();
          setMapReady(true);
          publishViewBounds();
        }}
        onViewportChange={() => {
          publishViewBounds();
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

      {conn.sync && (
        <SyncRibbon
          progress={conn.sync}
          onStop={conn.stopSync}
          onDismiss={conn.dismissSync}
          onReconnect={conn.sync.phase === 'needs-auth' ? () => setShowConnect(true) : undefined}
        />
      )}

      {/* An empty map with nothing running is a dead end: the sync stopped before it produced
          anything, or an earlier visit was interrupted. Say so and offer the way forward. */}
      {!IS_PUBLISHED_BUILD && store.load === 'no-artifacts' && !conn.sync && !conn.building && (
        <div className="panel" style={{ top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 320 }}>
          <h2>Nothing here yet</h2>
          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
            You are connected to Strava, but no activities have been downloaded yet.
          </div>
          <div style={{ display: 'flex', gap: 7 }}>
            <button className="ghost" onClick={conn.startSync}>
              Download my activities
            </button>
            <button className="ghost" onClick={() => setShowConnect(true)}>
              Reconnect
            </button>
          </div>
        </div>
      )}

      {conn.building && !conn.sync && (
        <div className="sync-ribbon">
          <div className="sync-ribbon-main">
            <div className="sync-ribbon-line1">Working out your coverage…</div>
            <div className="sync-ribbon-line2">This runs over your whole history at once.</div>
          </div>
        </div>
      )}

      {store.load === 'ready' && (
        <>
          <FilterPanel />
          <SearchBox onGo={searchGo} />
          <StatsCard />
          <Scrubber />
          {/* One stack rather than three hand-tuned `bottom:` values that drifted into each
              other and into the scrubber. Bottom-aligned to 150px, matching the legend on the
              right, and laid out column-reverse so whichever panels are open simply stack. */}
          <div className="left-rail">
            <div className="rail-row">
              <ThemeToggle />
              <button
                className="ghost"
                aria-pressed={showShare}
                onClick={() => setShowShare((v) => !v)}
                title="Copy a link to this view"
              >
                Share
              </button>
              {IS_PUBLISHED_BUILD ? (
                <PublishedFooter builtAt={store.manifest?.builtAt} />
              ) : (
                <AccountPanel
                  busy={conn.sync !== null || conn.building}
                  connected={conn.state === 'connected'}
                  onSync={conn.startSync}
                  onConnect={() => setShowConnect(true)}
                  onDisconnect={conn.disconnect}
                />
              )}
            </div>
            {showShare && (
              <SharePanel
                getViewBounds={() => mapRef.current?.getBounds() ?? null}
                onClose={() => setShowShare(false)}
              />
            )}
            {conn.report && <ImportReport report={conn.report} onClose={conn.dismissReport} />}
            {conn.buildError && (
              <div className="panel" style={{ width: 290 }}>
                <h2>Your map could not be rebuilt</h2>
                <div style={{ color: 'var(--text-secondary)', fontSize: 12.5, lineHeight: 1.5 }}>
                  {conn.buildError}
                </div>
                <button className="ghost" onClick={conn.rebuild} style={{ marginTop: 10 }}>
                  Try again
                </button>
              </div>
            )}
          </div>
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
                background: 'var(--tooltip-bg)',
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
