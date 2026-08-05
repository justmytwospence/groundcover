/** App state, plus URL-hash serialization so any view is reloadable and bookmarkable. */

import { create } from 'zustand';
import type { ActivitySummary, Manifest } from '@um/ledger';
import { initialChoice, resolveTheme, type Theme, type ThemeChoice } from '../lib/theme.js';
import type { MapMode, QueryExtras } from '../worker/protocol.js';

export type LoadState = 'loading' | 'ready' | 'no-artifacts' | 'format-mismatch' | 'failed';

export interface Stats {
  distinctM: number;
  newM: number;
  totalM: number | null;
  activityCount: number;
}

interface State {
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

function readHash(): Partial<State> {
  const h = new URLSearchParams(location.hash.slice(1));
  const out: Partial<State> = {};
  const num = (k: string) => {
    const v = h.get(k);
    return v === null ? undefined : Number(v);
  };
  const t0 = num('t0');
  const t1 = num('t1');
  if (t0 !== undefined) out.t0 = t0;
  if (t1 !== undefined) out.t1 = t1;
  const g = h.get('g');
  if (g) out.groups = g.split(',').map(Number).filter(Number.isFinite);
  const m = h.get('m');
  if (m === 'heatmap' || m === 'exploration') out.mode = m;
  if (h.get('vp') === '1') out.viewportFilter = true;
  if (h.get('fit') === '1') out.fitToSelection = true;
  if (h.get('fitplay') === '1') out.fitWhilePlaying = true;
  if (h.get('noskip') === '1') out.skipEmptyDays = false;
  const u = h.get('u');
  if (u === 'mi' || u === 'km') out.units = u;
  if (h.get('d') === '1') out.drawerOpen = true;
  return out;
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
  const fromHash = readHash();
  useStore.setState({
    minTs,
    maxTs,
    t0: fromHash.t0 ?? minTs,
    t1: fromHash.t1 ?? maxTs + DAY,
    groups: fromHash.groups ?? s.groups,
    mode: fromHash.mode ?? s.mode,
    viewportFilter: fromHash.viewportFilter ?? s.viewportFilter,
    fitToSelection: fromHash.fitToSelection ?? s.fitToSelection,
    fitWhilePlaying: fromHash.fitWhilePlaying ?? s.fitWhilePlaying,
    skipEmptyDays: fromHash.skipEmptyDays ?? s.skipEmptyDays,
    units: fromHash.units ?? s.units,
    drawerOpen: fromHash.drawerOpen ?? s.drawerOpen,
  });
}

let hashTimer: number | undefined;
export function startHashSync(getMapState: () => { c: [number, number]; z: number } | null): () => void {
  const write = () => {
    const s = useStore.getState();
    if (s.load !== 'ready') return;
    const h = new URLSearchParams();
    h.set('t0', String(Math.round(s.t0)));
    h.set('t1', String(Math.round(s.t1)));
    h.set('g', s.groups.join(','));
    h.set('m', s.mode);
    if (s.viewportFilter) h.set('vp', '1');
    if (s.fitToSelection) h.set('fit', '1');
    if (s.fitWhilePlaying) h.set('fitplay', '1');
    if (!s.skipEmptyDays) h.set('noskip', '1');
    h.set('u', s.units);
    if (s.drawerOpen) h.set('d', '1');
    const mp = getMapState();
    if (mp) h.set('map', `${mp.c[0].toFixed(4)},${mp.c[1].toFixed(4)},${mp.z.toFixed(2)}`);
    history.replaceState(null, '', `#${h.toString()}`);
  };
  return useStore.subscribe(() => {
    clearTimeout(hashTimer);
    hashTimer = window.setTimeout(write, 250);
  });
}

/**
 * Captured ONCE at module load, before the hash writer can touch it. Reading it lazily races
 * the writer: the writer omits `map=` while the map does not yet exist, so a later read would
 * see no saved view and the app would refit to the data, discarding a shared link's position.
 */
const INITIAL_MAP = (() => {
  const h = new URLSearchParams(location.hash.slice(1));
  const m = h.get('map');
  if (!m) return null;
  const [lng, lat, z] = m.split(',').map(Number);
  if (![lng, lat, z].every(Number.isFinite)) return null;
  return { center: [lng, lat] as [number, number], zoom: z };
})();

export function readMapFromHash(): { center: [number, number]; zoom: number } | null {
  return INITIAL_MAP;
}

export const M_PER_UNIT = { mi: 1609.344, km: 1000 };
export const fmtDist = (m: number, units: 'mi' | 'km'): string => {
  const v = m / M_PER_UNIT[units];
  return v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(1);
};
