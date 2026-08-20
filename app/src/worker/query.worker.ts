/**
 * Artifact loading and the query engine. See SPEC.md section 3.4.
 *
 * Everything interactive is two linear passes over typed arrays: a fold over the selected
 * activities, then a scan over all sites. No spatial index, no binary search, no bitsets --
 * the budget is met by linear passes and keeping them branch-light.
 */

import {
  FORMAT_VERSION,
  PARAMS_HASH,
  SPORT_GROUPS,
  latToY,
  lngToX,
  xToLng,
  yToLat,
  type ActivitySummary,
  type BlockRef,
  type Manifest,
} from '@um/ledger';
import { MODE_ALPHA, PALETTES } from '../lib/palette.js';
import { pickSource, type ArtifactSource } from './artifactSource.js';
import type {
  GroupRow,
  MapMode,
  QueryExtras,
  QueryRequest,
  SiteVisit,
  Viewport,
  WorkerIn,
  WorkerOut,
} from './protocol.js';

const post = (m: WorkerOut, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(m, transfer ?? []);

// ---------------------------------------------------------------------------------------
// Colour ramps. Kept in sync with app/src/theme.css and SPEC.md section 6.4.
// ---------------------------------------------------------------------------------------
const hex = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

/** Continuous ramps, kept in sync with app/src/lib/theme.ts. */
/** Sample a ramp of stops at t in [0,1], interpolating between neighbours. */
function sampleRamp(stops: [number, number, number][], t: number): [number, number, number] {
  if (stops.length === 1) return stops[0];
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  // Linear in sRGB is safe only because every stop shares a hue; across hues it would pass
  // through mud, which is the other reason the frontier is not part of this ramp.
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/**
 * Ramps come from lib/palette.ts rather than a copy kept here. The copy that used to live in
 * this file was the one that actually painted the map, so a palette change validated against
 * the other definitions could -- and did -- ship without altering a single pixel.
 */
const rampsFor = (theme: 'dark' | 'light') => {
  const p = PALETTES[theme] ?? PALETTES.dark;
  return { frontier: hex(p.frontier), repeat: p.gradient.map(hex), heat: p.heatmap.map(hex) };
};


// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------
let manifest: Manifest | null = null;
let activities: ActivitySummary[] = [];
let nSites = 0;

let siteX: Int32Array;
let siteY: Int32Array;
let siteCreditCm: Uint16Array;
let siteMintAct: Uint32Array;
/** First and last moment each activity minted ground, derived once at load. */
let actMintStart: Float64Array;
let actMintEnd: Float64Array;
let siteMintTs: Uint32Array;
let firstTsByGroup: Uint32Array[] = [];
let actOffsets: Uint32Array;
let touchSiteIds: Uint32Array;
let touchDirs: Uint8Array;
let siteBearing: Uint8Array;

let visitCount: Uint16Array;
/**
 * Visit-count histogram for the visible sites, reused each query.
 *
 * The ramp is scaled to a high percentile rather than the maximum. One much-loved doorstep can
 * reach a hundred-odd visits while nearly everything else sits in single figures, and scaling
 * to that outlier squeezes the entire history into the first slice of the gradient. The last
 * bucket is an overflow, so counts beyond it still register without a huge array.
 */
const HIST_BUCKETS = 1024;
const hist = new Uint32Array(HIST_BUCKETS);
const colorSlots: (Uint8Array | null)[] = [null, null];
const slotFree: boolean[] = [true, true];

/** Incremental-fold state: which window the current visitCount reflects. */
let foldT0 = NaN;
let foldT1 = NaN;
let foldGroupKey = '';

function view(buf: ArrayBuffer, ref: BlockRef): Int32Array | Uint32Array | Uint16Array | Uint8Array {
  switch (ref.type) {
    case 'Int32':
      return new Int32Array(buf, ref.byteOffset, ref.length);
    case 'Uint32':
      return new Uint32Array(buf, ref.byteOffset, ref.length);
    case 'Uint16':
      return new Uint16Array(buf, ref.byteOffset, ref.length);
    default:
      return new Uint8Array(buf, ref.byteOffset, ref.length);
  }
}

let source: ArtifactSource | null = null;

async function init(): Promise<void> {
  let loaded = 0;
  const bump = (n: number) => {
    loaded += n;
    post({ type: 'progress', loaded, total: 0 });
  };

  source = await pickSource(bump);
  if (!source) {
    // No data yet is the ordinary first-visit state, not a failure.
    post({ type: 'error', kind: 'no-artifacts', message: 'No history imported yet.' });
    return;
  }

  const mf = await source.manifest();
  if (!mf) {
    post({ type: 'error', kind: 'no-artifacts', message: 'No history imported yet.' });
    return;
  }

  if (mf.formatVersion !== FORMAT_VERSION) {
    // Unreadable, not merely stale: do not create typed-array views over an unknown layout.
    post({
      type: 'error',
      kind: 'format-mismatch',
      message: `Artifacts use format ${mf.formatVersion}, this build expects ${FORMAT_VERSION}.`,
    });
    return;
  }

  const [sitesBuf, touchesBuf, actsJson] = await Promise.all([
    source.block('sites'),
    source.block('touches'),
    source.activities(),
  ]);

  // The manifest is written last precisely so this can be trusted, but a block whose size
  // disagrees with what the manifest claims means the set is torn anyway -- an interrupted
  // write, or eviction of one record. Every offset below is taken from the manifest, so
  // continuing would either throw deep inside `view()` or, worse, succeed against the previous
  // build's bytes and render coherent-looking nonsense. A rebuild costs no Strava requests.
  for (const [name, buf] of [
    ['sites', sitesBuf],
    ['touches', touchesBuf],
  ] as const) {
    const expected = mf.files[name].byteLength;
    if (buf.byteLength !== expected) {
      post({
        type: 'error',
        kind: 'format-mismatch',
        message:
          `Your stored map is incomplete: ${name} is ${buf.byteLength} bytes where it should ` +
          `be ${expected}. Rebuilding fixes this and costs no Strava requests.`,
      });
      return;
    }
  }

  manifest = mf;
  activities = actsJson;
  nSites = mf.counts.sites;
  const sb = mf.files.sites.blocks;

  siteX = view(sitesBuf, sb.x) as Int32Array;
  siteY = view(sitesBuf, sb.y) as Int32Array;
  siteCreditCm = view(sitesBuf, sb.creditCm) as Uint16Array;
  siteMintTs = view(sitesBuf, sb.mintTs) as Uint32Array;
  siteMintAct = view(sitesBuf, sb.mintAct) as Uint32Array;
  firstTsByGroup = sb.firstTsByGroup.map((r) => view(sitesBuf, r) as Uint32Array);
  actOffsets = view(touchesBuf, mf.files.touches.blocks.actOffsets) as Uint32Array;
  touchSiteIds = view(touchesBuf, mf.files.touches.blocks.siteIds) as Uint32Array;
  touchDirs = view(touchesBuf, mf.files.touches.blocks.dirs) as Uint8Array;

  // One pass to learn each activity's minting span, which is what lets a route be revealed
  // over a fixed wall-clock duration instead of however long the activity happened to take.
  actMintStart = new Float64Array(activities.length).fill(Infinity);
  actMintEnd = new Float64Array(activities.length).fill(-Infinity);
  for (let i = 0; i < nSites; i++) {
    const a = siteMintAct[i];
    if (a >= actMintStart.length) continue;
    const ts = siteMintTs[i];
    if (ts < actMintStart[a]) actMintStart[a] = ts;
    if (ts > actMintEnd[a]) actMintEnd[a] = ts;
  }

  visitCount = new Uint16Array(nSites);
  colorSlots[0] = new Uint8Array(4 * nSites);
  colorSlots[1] = new Uint8Array(4 * nSites);

  // Derive render geometry once: each site becomes a short segment centred on its position
  // and oriented along its bearing. Float32 lng/lat gives ~0.6 m precision, well inside an 8 m mark.
  const bearing = view(sitesBuf, sb.bearing) as Uint8Array;
  siteBearing = bearing;
  const half = ((mf.params.RESAMPLE_M as number) ?? 8) / 2;
  const src = new Float32Array(2 * nSites);
  const dst = new Float32Array(2 * nSites);
  for (let i = 0; i < nSites; i++) {
    const x = siteX[i] / 100;
    const y = siteY[i] / 100;
    const lat = yToLat(y);
    const cosLat = Math.cos((lat * Math.PI) / 180);
    // Stored bearing is in units of 2 degrees over 0..358.
    const rad = (bearing[i] * 2 * Math.PI) / 180;
    const dx = (Math.sin(rad) * half) / cosLat;
    const dy = (Math.cos(rad) * half) / cosLat;
    src[2 * i] = xToLng(x - dx);
    src[2 * i + 1] = yToLat(y - dy);
    dst[2 * i] = xToLng(x + dx);
    dst[2 * i + 1] = yToLat(y + dy);
  }

  const mintTsCopy = siteMintTs.slice();
  const mintActCopy = siteMintAct.slice();
  post(
    {
      type: 'ready',
      manifest: mf,
      activities,
      sourcePositions: src,
      targetPositions: dst,
      nSites,
      siteMintTs: mintTsCopy,
      siteMintAct: mintActCopy,
    },
    [src.buffer, dst.buffer, mintTsCopy.buffer, mintActCopy.buffer],
  );

  if (mf.paramsHash !== PARAMS_HASH) {
    // Readable, just built with different parameters: warn but let the app render.
    post({
      type: 'error',
      kind: 'params-mismatch',
      message: 'Artifacts were built with different algorithm parameters. Run `npm run build:ledger`.',
    });
  }
}

// ---------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------

function inViewport(i: number, vp: Viewport): boolean {
  const x = siteX[i];
  const y = siteY[i];
  return x >= vp.minX && x <= vp.maxX && y >= vp.minY && y <= vp.maxY;
}

/** Fold one activity's touched sites into visitCount. */
function foldActivity(idx: number, delta: 1 | -1): void {
  const from = actOffsets[idx];
  const to = actOffsets[idx + 1];
  for (let k = from; k < to; k++) visitCount[touchSiteIds[k]] += delta;
}

function qualifies(a: ActivitySummary, t0: number, t1: number, groupSet: Set<number>): boolean {
  return a.startTs >= t0 && a.startTs <= t1 && groupSet.has(a.group);
}

function runFold(req: QueryRequest, groupSet: Set<number>): number {
  const key = [...groupSet].sort().join(',');
  const canIncrement =
    req.incremental === true &&
    key === foldGroupKey &&
    foldT0 === req.t0 &&
    Number.isFinite(foldT1) &&
    req.t1 >= foldT1;

  if (canIncrement) {
    // Expanding window: only fold in what newly entered.
    let count = 0;
    for (const a of activities) {
      if (groupSet.has(a.group) && a.startTs >= req.t0 && a.startTs <= req.t1) count++;
      if (groupSet.has(a.group) && a.startTs > foldT1 && a.startTs <= req.t1) foldActivity(a.idx, 1);
    }
    foldT1 = req.t1;
    return count;
  }

  visitCount.fill(0);
  let count = 0;
  for (const a of activities) {
    if (qualifies(a, req.t0, req.t1, groupSet)) {
      foldActivity(a.idx, 1);
      count++;
    }
  }
  foldT0 = req.t0;
  foldT1 = req.t1;
  foldGroupKey = key;
  return count;
}

/**
 * @param revealTs During playback, ground first covered after this instant stays hidden, so a
 *   route draws itself along its path instead of appearing whole. Infinity outside playback:
 *   a static selection means the activities in it, entire, which is what the stats count.
 */
/**
 * @param revealTs Ground first covered after this instant stays hidden. Infinity outside
 *   playback: a static selection means the activities in it, entire.
 *
 * No stretching happens here any more. The transport moves the playhead slowly across each
 * activity's own span and skips between them, so a plain comparison already draws the route in
 * the order it was travelled, at a pace the transport controls.
 */
/**
 * @param maxVisit The busiest visible ground, which the ramp is rescaled to. Fixed bands wasted
 *   most of the ramp on a window whose repeats never exceed three, and saturated it on one that
 *   reaches forty; rescaling per query means the colours always spend their range on the data
 *   actually on screen.
 */
function writeColors(
  out: Uint8Array,
  mode: MapMode,
  theme: 'dark' | 'light',
  revealTs: number,
  reverse: boolean,
  maxVisit: number,
): void {
  const surface: 'dark' | 'light' = theme === 'light' ? 'light' : 'dark';
  const g = rampsFor(surface);
  const heat = mode === 'heatmap';
  const stops = heat ? g.heat : g.repeat;
  const alpha = heat ? MODE_ALPHA[surface].heatmap : MODE_ALPHA[surface].exploration;
  // Exploration reserves one visit for the frontier, so the ramp covers two upwards; the
  // heatmap has no reserved accent and spans the whole range.
  const lo = heat ? 1 : 2;
  const denom = Math.max(1, maxVisit - lo);
  for (let i = 0; i < nSites; i++) {
    const v = visitCount[i];
    const o = 4 * i;

    // siteMintTs is the moment this ground was first covered. Artifacts built before that was
    // recorded per sample carry the activity's start instead, so every site in an activity
    // clears the gate together and playback simply behaves as it used to -- degraded, never
    // broken, and self-healing on the next rebuild.
    // Running backwards shows everything NEWER than the playhead: the map fills from the most
    // recent history towards the oldest, which is the order a sync delivers it in.
    if (v === 0 || (reverse ? siteMintTs[i] < revealTs : siteMintTs[i] > revealTs)) {
      out[o + 3] = 0;
      continue;
    }
    const c =
      !heat && v <= 1 ? g.frontier : sampleRamp(stops as [number, number, number][], (v - lo) / denom);
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = alpha;
  }
}

/** Earliest visit to site i by any of the selected groups; 0xffffffff when never. */
function firstTsUnder(i: number, groups: number[]): number {
  let best = 0xffffffff;
  for (let g = 0; g < groups.length; g++) {
    const t = firstTsByGroup[groups[g]][i];
    if (t < best) best = t;
  }
  return best;
}

function computeExtras(req: QueryRequest, groupSet: Set<number>): QueryExtras {
  // Per-activity new ground UNDER THE CURRENT SPORT FILTER. The artifacts' newGroundM is a
  // global, unfiltered figure, so using it here would contradict the headline number.
  const selected = activities.filter((a) => qualifies(a, req.t0, req.t1, groupSet));
  const perActivityNewM: Array<{ idx: number; newM: number }> = [];
  for (const a of selected) {
    let m = 0;
    const from = actOffsets[a.idx];
    const to = actOffsets[a.idx + 1];
    for (let k = from; k < to; k++) {
      const s = touchSiteIds[k];
      if (firstTsUnder(s, req.groups) === a.startTs && siteMintAct[s] === a.idx) m += siteCreditCm[s] / 100;
    }
    perActivityNewM.push({ idx: a.idx, newM: m });
  }
  perActivityNewM.sort((x, y) => y.newM - x.newM);

  // Buckets by the athlete's own local calendar, monthly under three years and yearly above.
  const spanYears = (req.t1 - req.t0) / (365.25 * 86400);
  const monthly = spanYears < 3;
  const buckets = new Map<number, { newM: number; totalM: number }>();
  const newByIdx = new Map<number, number>(perActivityNewM.map((r) => [r.idx, r.newM]));
  for (const a of selected) {
    const d = new Date(a.startDateLocal);
    const key = monthly ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth()) : Date.UTC(d.getUTCFullYear(), 0);
    const b = buckets.get(key) ?? { newM: 0, totalM: 0 };
    b.newM += newByIdx.get(a.idx) ?? 0;
    b.totalM += a.distanceM;
    buckets.set(key, b);
  }
  const byBucket = [...buckets.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([bucketStart, v]) => ({ bucketStart: bucketStart / 1000, ...v }));

  // Per-group figures need their own fold each: ground covered by two sports belongs to both
  // rows, so per-group numbers cannot be sliced out of one combined result.
  const byGroup: GroupRow[] = [];
  const savedT0 = foldT0;
  const savedT1 = foldT1;
  const savedKey = foldGroupKey;
  for (const g of req.groups) {
    const one = new Set([g]);
    runFold({ ...req, incremental: false }, one);
    let distinctM = 0;
    let newM = 0;
    for (let i = 0; i < nSites; i++) {
      if (visitCount[i] > 0) distinctM += siteCreditCm[i] / 100;
      const ft = firstTsByGroup[g][i];
      if (ft !== 0xffffffff && ft >= req.t0 && ft <= req.t1) newM += siteCreditCm[i] / 100;
    }
    let totalM = 0;
    for (const a of activities) if (a.group === g && a.startTs >= req.t0 && a.startTs <= req.t1) totalM += a.distanceM;
    if (totalM > 0 || distinctM > 0) byGroup.push({ group: g, distinctM, newM, totalM });
  }
  // Restore the combined fold the caller expects.
  runFold({ ...req, incremental: false }, groupSet);
  foldT0 = savedT0;
  foldT1 = savedT1;
  foldGroupKey = savedKey;

  return { perActivityNewM: perActivityNewM.slice(0, 20), byBucket, byGroup };
}

function handleQuery(req: QueryRequest): void {
  if (!manifest) return;
  const groupSet = new Set(req.groups);

  const activityCountAll = runFold(req, groupSet);
  const extras = req.drawer ? computeExtras(req, groupSet) : undefined;
  if (req.drawer) runFold({ ...req, incremental: false }, groupSet);

  const slot: 0 | 1 = slotFree[0] ? 0 : 1;
  slotFree[slot] = false;
  const colors = colorSlots[slot]!;

  let distinctM = 0;
  let newM = 0;
  const vp = req.viewport;
  // Tallied over the same pass that already walks every site, so scaling the ramp costs a
  // histogram increment rather than a second scan.
  hist.fill(0);
  let visibleSites = 0;
  for (let i = 0; i < nSites; i++) {
    const v = visitCount[i];
    const visible = !vp || inViewport(i, vp);
    if (v > 0 && visible) {
      distinctM += siteCreditCm[i] / 100;
      hist[Math.min(v, HIST_BUCKETS - 1)]++;
      visibleSites++;
    }
    if (visible) {
      const ft = firstTsUnder(i, req.groups);
      if (ft !== 0xffffffff && ft >= req.t0 && ft <= req.t1) newM += siteCreditCm[i] / 100;
    }
  }
  // The 98th percentile: high enough that the ramp still reaches its top on ordinary ground,
  // low enough that a single much-worn spot does not eat the whole scale. Anything above it
  // clamps to the last colour, which is the honest reading -- "at least this many".
  let maxVisit = 1;
  {
    const target = visibleSites * 0.98;
    let seen = 0;
    for (let v = 1; v < HIST_BUCKETS; v++) {
      seen += hist[v];
      if (seen >= target) {
        maxVisit = v;
        break;
      }
    }
  }

  // A replay pins the scale to what it was when play began. Rescaling every frame repaints
  // ground that was already drawn, so the map churns instead of accumulating -- which reads as
  // the animation being wrong long before anyone works out that it is the colours moving.
  const scale = req.scaleMax && req.scaleMax > 1 ? req.scaleMax : maxVisit;

  writeColors(
    colors,
    req.mode,
    req.theme ?? 'dark',
    req.playing ? (req.reverse ? req.t0 : req.t1) : req.reverse ? -Infinity : Infinity,
    req.reverse === true,
    scale,
  );

  let totalM: number | null = 0;
  let activityCount = activityCountAll;
  if (vp) {
    totalM = null;
    activityCount = activities.filter(
      (a) =>
        qualifies(a, req.t0, req.t1, groupSet) &&
        a.bbox[0] <= xToLng(vp.maxX / 100) &&
        a.bbox[2] >= xToLng(vp.minX / 100) &&
        a.bbox[1] <= yToLat(vp.maxY / 100) &&
        a.bbox[3] >= yToLat(vp.minY / 100),
    ).length;
  } else {
    for (const a of activities) if (qualifies(a, req.t0, req.t1, groupSet)) totalM += a.distanceM;
  }

  const buf = colors.buffer as ArrayBuffer;
  post(
    { type: 'result', slot, colors: buf, distinctM, newM, totalM, activityCount, maxVisit: scale, extras },
    [buf],
  );
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Encoded bearing (2-degree units over 0..358) to an 8-point compass label. */
function compass(encoded: number): string {
  const deg = (encoded * 2) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/**
 * Detail for one site, computed on demand. Sending per-site counts with every query would
 * mean copying another 1.6 MB per frame; hovering is rare enough to ask for it instead.
 */
function handleSiteAt(req: {
  lng: number;
  lat: number;
  radiusM: number;
  t0: number;
  t1: number;
  groups: number[];
  seq: number;
  detail?: boolean;
}): void {
  if (!manifest) return;

  // Sites are stored in Mercator centimetres; compare there and convert the radius once.
  const qx = lngToX(req.lng) * 100;
  const qy = latToY(req.lat) * 100;
  const cosLat = Math.cos((req.lat * Math.PI) / 180);
  const rMerc = (req.radiusM / cosLat) * 100;
  const r2 = rMerc * rMerc;

  let bestI = -1;
  let bestD2 = r2;
  for (let i = 0; i < nSites; i++) {
    const dx = siteX[i] - qx;
    if (dx > rMerc || dx < -rMerc) continue;
    const dy = siteY[i] - qy;
    if (dy > rMerc || dy < -rMerc) continue;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestI = i;
    }
  }

  if (bestI < 0) {
    post({
      type: 'siteInfoResult',
      seq: req.seq,
      siteIndex: -1,
      visits: 0,
      alongCount: 0,
      againstCount: 0,
      alongLabel: '',
      againstLabel: '',
      firstTs: 0,
      lastTs: 0,
      firstActivityName: '',
      visitsAllTime: 0,
    });
    return;
  }

  const i = bestI;
  const groupSet = new Set(req.groups);
  let visits = 0;
  let visitsAllTime = 0;
  let alongCount = 0;
  let againstCount = 0;
  let firstTs = 0;
  let lastTs = 0;
  let firstActivityName = '';
  const detail: SiteVisit[] = [];

  for (const a of activities) {
    // Touch lists are sorted, so a binary search finds this site in a few steps.
    let lo = actOffsets[a.idx];
    let hi = actOffsets[a.idx + 1] - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = touchSiteIds[mid];
      if (v === i) {
        at = mid;
        break;
      }
      if (v < i) lo = mid + 1;
      else hi = mid - 1;
    }
    if (at < 0) continue;

    visitsAllTime++;
    if (a.startTs < req.t0 || a.startTs > req.t1 || !groupSet.has(a.group)) continue;

    visits++;
    const d = touchDirs[at];
    if (d & 1) alongCount++;
    if (d & 2) againstCount++;
    if (req.detail) {
      detail.push({
        idx: a.idx,
        stravaId: a.stravaId,
        name: a.name,
        startTs: a.startTs,
        startDateLocal: a.startDateLocal,
        sportType: a.sportType,
        dir: d,
      });
    }
    if (firstTs === 0 || a.startTs < firstTs) {
      firstTs = a.startTs;
      firstActivityName = a.name;
    }
    if (a.startTs > lastTs) lastTs = a.startTs;
  }

  const b = siteBearing[i];
  post({
    type: 'siteInfoResult',
    seq: req.seq,
    siteIndex: i,
    visits,
    alongCount,
    againstCount,
    alongLabel: compass(b),
    againstLabel: compass((b + 90) % 180),
    firstTs,
    lastTs,
    firstActivityName,
    visitsAllTime,
    activities: req.detail ? detail.sort((x, y) => y.startTs - x.startTs) : undefined,
  });
}

async function loadTracks(): Promise<void> {
  if (!manifest) return;
  if (!source) return;
  const buf = await source.block('tracks');
  const b = manifest.files.tracks.blocks;
  const trackOffsets = (view(buf, b.trackOffsets) as Uint32Array).slice();
  const px = (view(buf, b.px) as Int32Array).slice();
  const py = (view(buf, b.py) as Int32Array).slice();
  const flag = (view(buf, b.flag) as Uint8Array).slice();
  post({ type: 'tracks', trackOffsets, px, py, flag }, [
    trackOffsets.buffer,
    px.buffer,
    py.buffer,
    flag.buffer,
  ]);
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      init().catch((err) => post({ type: 'error', kind: 'failed', message: String(err) }));
      break;
    case 'query':
      try {
        handleQuery(msg);
      } catch (err) {
        post({ type: 'error', kind: 'failed', message: String(err) });
      }
      break;
    case 'release':
      colorSlots[msg.slot] = new Uint8Array(msg.colors);
      slotFree[msg.slot] = true;
      break;
    case 'siteAt':
      try {
        handleSiteAt(msg);
      } catch (err) {
        post({ type: 'error', kind: 'failed', message: String(err) });
      }
      break;
    case 'loadTracks':
      loadTracks().catch((err) => post({ type: 'error', kind: 'failed', message: String(err) }));
      break;
  }
};

export { SPORT_GROUPS };
