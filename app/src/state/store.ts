/** App state, plus URL-hash serialization so any view is reloadable and bookmarkable. */

import { create } from 'zustand';
import type { ActivitySummary, Manifest } from '@um/ledger';
import { initialChoice, resolveTheme, type Theme, type ThemeChoice } from '../lib/theme.js';
import type { MapMode, QueryExtras } from '../worker/protocol.js';
import { clampWindow, parseHash, type InitialView } from './hash.js';

export type { InitialView };
export { parseHash };

export type LoadState = 'loading' | 'ready' | 'no-artifacts' | 'format-mismatch' | 'failed';

export interface Stats {
  distinctM: number;
  newM: number;
  totalM: number | null;
  activityCount: number;
}

export interface State {
  load: LoadState;
  /** What is on screen. */
  theme: Theme;
  /** What the user asked for; 'system' means keep following the operating system. */
  themeChoice: ThemeChoice;
  hillshade: boolean;
  loadError: string;
  paramsWarning: string;
  manifest: Manifest | null;
  activities: ActivitySummary[];

  t0: number;
  t1: number;
  minTs: number;
  maxTs: number;
  groups: number[];
  mode: MapMode;
  viewportFilter: boolean;
  /** Refit the map to the data in the current selection whenever that selection changes. */
  fitToSelection: boolean;
  /**
   * Whether "fit to selection" also applies while the time-lapse is playing.
   *
   * Off by default. Playback moves the window every frame, so refitting on each one turns a
   * quiet reveal into the map lurching around, and you lose the very thing playback is for:
   * watching one place fill in over time.
   */
  fitWhilePlaying: boolean;
  units: 'mi' | 'km';
  drawerOpen: boolean;
  filtersOpen: boolean;
  statsOpen: boolean;

  playing: boolean;
  /**
   * Where the replay has reached, independent of the selection.
   *
   * Playback used to advance t1 itself, which meant pressing play destroyed the window you had
   * chosen -- it collapsed to a line and grew back. The selection is now yours and stays put;
   * this rides inside it. Null means "not mid-replay", and the map shows the whole selection.
   */
  playhead: number | null;
  speed: number;
  /** Compress empty stretches so the replay spends its time where something happened. */
  skipEmptyDays: boolean;
  /** Skip activities that fall entirely outside the map view, so the replay stays on screen. */
  skipOutsideBounds: boolean;
  /** The map's visible extent in degrees, kept here so the transport can consult it. */
  viewBounds: [number, number, number, number] | null;
  /**
   * Run the replay newest-first, which is the order a Strava sync actually delivers history in.
   *
   * Only used while a backfill is running. Watching the map fill backwards matches what is
   * arriving, instead of replaying from a beginning that has not downloaded yet.
   */
  replayReverse: boolean;
  /**
   * First and last moment each activity minted ground, interleaved as [start, end, start, ...].
   *
   * The transport paces itself to these rather than to the calendar: that is what makes exactly
   * one route draw at a time regardless of how activities happen to be spaced.
   */
  actSpans: Float64Array | null;
  /** Busiest visible ground in the last query, for scaling the legend. */
  maxVisit: number;
  activeActivity: number | null;

  stats: Stats;
  extras: QueryExtras | null;

  set: (p: Partial<State>) => void;
  setWindow: (t0: number, t1: number) => void;
  toggleGroup: (g: number) => void;
}

const DAY = 86400;

/** The selection half of the hash: everything except the camera. */
function writeSelection(s: State): URLSearchParams {
  const h = new URLSearchParams();
  h.set('t0', String(Math.round(s.t0)));
  h.set('t1', String(Math.round(s.t1)));
  h.set('g', s.groups.join(','));
  h.set('m', s.mode);
  if (s.viewportFilter) h.set('vp', '1');
  if (s.fitToSelection) h.set('fit', '1');
  if (s.fitWhilePlaying) h.set('fitplay', '1');
  if (!s.skipEmptyDays) h.set('noskip', '1');
  if (s.skipOutsideBounds) h.set('inview', '1');
  h.set('u', s.units);
  if (s.drawerOpen) h.set('d', '1');
  if (s.playing) h.set('play', '1');
  return h;
}

export const useStore = create<State>((set, get) => ({
  load: 'loading',
  theme: resolveTheme(initialChoice()),
  themeChoice: initialChoice(),
  hillshade: localStorage.getItem('um.hillshade') === '1',
  loadError: '',
  paramsWarning: '',
  manifest: null,
  activities: [],

  t0: 0,
  t1: 0,
  minTs: 0,
  maxTs: 0,
  groups: [0, 1, 2, 3, 4],
  mode: 'exploration',
  viewportFilter: false,
  fitToSelection: false,
  fitWhilePlaying: false,
  units: 'mi',
  drawerOpen: false,
  filtersOpen: true,
  statsOpen: true,

  playing: false,
  playhead: null,
  speed: 1,
  skipEmptyDays: true,
  skipOutsideBounds: false,
  viewBounds: null,
  replayReverse: false,
  actSpans: null,
  maxVisit: 1,
  activeActivity: null,

  stats: { distinctM: 0, newM: 0, totalM: 0, activityCount: 0 },
  extras: null,

  set: (p) => set(p),
  setWindow: (t0, t1) =>
    set({ t0: Math.min(t0, t1), t1: Math.max(t0, t1), playhead: null, playing: false }),
  toggleGroup: (g) => {
    const cur = get().groups;
    const next = cur.includes(g) ? cur.filter((x) => x !== g) : [...cur, g].sort();
    // Never let the selection go empty: an empty universe reads as a bug, not a filter.
    set({ groups: next.length ? next : cur });
  },
}));

if (import.meta.env.DEV) {
  // Dev-only handle for console debugging.
  (window as unknown as Record<string, unknown>).__umStore = useStore;
}

/** Apply URL state once the time range is known. */
export function hydrateFromHash(minTs: number, maxTs: number): void {
  const s = useStore.getState();
  const { view } = parseHash(location.hash);
  const hi = maxTs + DAY;
  const win = clampWindow(view.t0, view.t1, minTs, hi);
  useStore.setState({
    minTs,
    maxTs,
    t0: win?.[0] ?? minTs,
    t1: win?.[1] ?? hi,
    groups: view.groups ?? s.groups,
    mode: view.mode ?? s.mode,
    viewportFilter: view.viewportFilter ?? s.viewportFilter,
    fitToSelection: view.fitToSelection ?? s.fitToSelection,
    fitWhilePlaying: view.fitWhilePlaying ?? s.fitWhilePlaying,
    skipEmptyDays: view.skipEmptyDays ?? s.skipEmptyDays,
    skipOutsideBounds: view.skipOutsideBounds ?? s.skipOutsideBounds,
    units: view.units ?? s.units,
    drawerOpen: view.drawerOpen ?? s.drawerOpen,
    playing: view.playing ?? false,
  });
}

/**
 * Where the map was, kept per tab rather than in the URL.
 *
 * The address bar used to carry `map=lng,lat,zoom`, rewritten on every pan, so every link
 * anyone copied out of it silently pinned the sharer's camera onto the recipient. The position
 * is still worth keeping across a reload, so it lives here instead: same tab, not the link.
 * Sharing a view is now something you ask for, in the share panel.
 */
const CAMERA_KEY = 'um.camera';

function saveCamera(b: [number, number, number, number]): void {
  try {
    sessionStorage.setItem(CAMERA_KEY, b.map((v) => v.toFixed(5)).join(','));
  } catch {
    // A private-mode storage refusal is not worth breaking the map over.
  }
}

/** Part of "disconnect and erase": see `useConnection.disconnect`. */
export function forgetCamera(): void {
  try {
    sessionStorage.removeItem(CAMERA_KEY);
  } catch {
    // Nothing was stored if storage is refused, so there is nothing to forget.
  }
}

function loadCamera(): InitialView | null {
  try {
    const b = sessionStorage.getItem(CAMERA_KEY)?.split(',').map(Number);
    if (!b || b.length !== 4 || !b.every(Number.isFinite)) return null;
    return { kind: 'bounds', bounds: [b[0], b[1], b[2], b[3]] };
  } catch {
    return null;
  }
}

/**
 * The link to hand someone else.
 *
 * `includeView: false` -- the default -- deliberately omits the camera, so the recipient's map
 * fits the shared time frame: they see the ground that window covers, framed for their own
 * screen. `includeView: true` pins the exact extent on screen now, for when the framing is
 * itself the point.
 */
export function buildShareUrl(
  includeView: boolean,
  viewBounds: [number, number, number, number] | null,
  autoplay = false,
): string {
  const h = writeSelection(useStore.getState());
  if (includeView && viewBounds) h.set('b', viewBounds.map((v) => v.toFixed(4)).join(','));
  // Set AND cleared: `writeSelection` emits play=1 whenever the time-lapse happens to be
  // running, so without the delete the checkbox could only ever add autoplay, never remove it
  // from a link copied mid-playback.
  if (autoplay) h.set('play', '1');
  else h.delete('play');
  return `${location.origin}${location.pathname}${location.search}#${h.toString()}`;
}

let hashTimer: number | undefined;
export function startHashSync(getViewBounds: () => [number, number, number, number] | null): () => void {
  const write = () => {
    const s = useStore.getState();
    if (s.load !== 'ready') return;
    history.replaceState(null, '', `#${writeSelection(s).toString()}`);
    const b = getViewBounds();
    if (b) saveCamera(b);
  };
  return useStore.subscribe(() => {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(write, 250);
  });
}

/**
 * Captured ONCE at module load, before the hash writer can touch it. Reading it lazily races
 * the writer, which never emits a camera: a later read would find none and the app would throw
 * away a shared link's framing.
 *
 * Session storage is the fallback, never the priority: a camera named by the link always beats
 * wherever this tab happened to be looking.
 */
const INITIAL_VIEW: InitialView | null = (() => {
  const { view, camera } = parseHash(location.hash);
  if (camera) return camera;
  // A link carrying a window but no camera asks to be framed on that window. Restoring where
  // this tab was looking would silently win and open a stranger's link on your own ground.
  if (view.t0 !== undefined || view.t1 !== undefined) return null;
  return loadCamera();
})();

export function readInitialView(): InitialView | null {
  return INITIAL_VIEW;
}

/**
 * What a hash without a given flag means: off. Kept beside `writeSelection`, which is what
 * decides that an option at its default is simply omitted.
 */
const DEFAULTED_BY_HASH = {
  viewportFilter: false,
  fitToSelection: false,
  fitWhilePlaying: false,
  skipEmptyDays: true,
  skipOutsideBounds: false,
  drawerOpen: false,
  playing: false,
} satisfies Partial<State>;

/**
 * Pasting a link into the address bar of a tab that is already here fires `hashchange` and
 * nothing else -- no reload, no remount. Without this the address changes and the map does not,
 * which is indistinguishable from a broken link. Our own debounced writes are recognised by
 * comparing against what we would have written.
 */
export function startHashListener(onView: (v: InitialView | null) => void): () => void {
  const onChange = () => {
    const s = useStore.getState();
    if (s.load !== 'ready') return;
    if (location.hash.replace(/^#/, '') === writeSelection(s).toString()) return;
    const { view, camera } = parseHash(location.hash);
    if (Object.keys(view).length === 0 && !camera) return;
    const win = clampWindow(view.t0, view.t1, s.minTs, s.maxTs + DAY);
    useStore.setState({
      // Defaults are restored rather than merged. `parseHash` only reports the options a link
      // turns ON, because that is all the writer emits, so merging would leave this tab's
      // leftover flags set and render the same link differently from a fresh load.
      ...DEFAULTED_BY_HASH,
      ...view,
      ...(win ? { t0: win[0], t1: win[1] } : {}),
      playhead: null,
    });
    // Null too: a link with no camera is the common one, and it means "frame the window you
    // just applied", not "leave the recipient wherever they happened to be looking".
    onView(camera);
  };
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export const M_PER_UNIT = { mi: 1609.344, km: 1000 };
export const fmtDist = (m: number, units: 'mi' | 'km'): string => {
  const v = m / M_PER_UNIT[units];
  return v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(1);
};
