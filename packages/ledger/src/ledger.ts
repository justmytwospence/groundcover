/**
 * Stage 2 (the ledger), Stage 3 (tombstone passes), Pass II (attribution), and Stage 4
 * (derived outputs). See docs/algorithm.md sections 4 through 7.
 */

import { angDiff180, angDiff360, groundDist, xToLng, yToLat } from './geo.js';
import { nearestCandidate, SiteGrid, SiteTable } from './match.js';
import { SPORT_GROUPS, type Params } from './params.js';
import { preprocess, type Sample } from './preprocess.js';
import {
  LABEL_AMBIGUOUS,
  LABEL_NEW,
  LABEL_NONE,
  LABEL_REPEAT,
  type ActivitySummary,
  type LedgerInput,
} from './types.js';

/** Pass I labels, kept separate from the persisted per-sample labels of Pass II. */
const P1_NEW = 0;
const P1_REPEAT = 1;
const P1_AMBIGUOUS = 2;

/** Result of the whole build, before serialization. */
export interface BuiltLedger {
  sites: {
    n: number;
    x: Float64Array;
    y: Float64Array;
    bearing: Uint8Array;
    creditM: Float32Array;
    mintTs: Uint32Array;
    mintAct: Uint32Array;
    firstTsByGroup: Uint32Array[];
  };
  touches: { actOffsets: Uint32Array; siteIds: Uint32Array };
  tracks: { trackOffsets: Uint32Array; px: Int32Array; py: Int32Array; flag: Uint8Array };
  activities: ActivitySummary[];
  totals: { uniqueMeters: number; totalMeters: number };
  bounds: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  timeRange: { minTs: number; maxTs: number };
}

interface PerActivity {
  summary: ActivitySummary;
  samples: Sample[];
  labels: Uint8Array;
  siteIds: Int32Array;
  touches: Uint32Array;
}

/**
 * The wrap-repeat rule (section 4.3.1). Reached only when the guarded query found nothing
 * within R_NEW, so any site within R_REP here is necessarily same-activity and guard-hidden.
 */
function wrappedBack(
  p: Sample,
  sites: SiteTable,
  grid: SiteGrid,
  currentAct: number,
  params: Params,
): boolean {
  let found = false;
  grid.forEachNear(p.x, p.y, p.cosLat, params.R_REP, (id) => {
    if (found || !sites.alive[id]) return;
    if (sites.mintAct[id] !== currentAct) return;
    if (angDiff180(sites.bearing[id], p.bearing) > params.BEARING_TOL) return;
    const sa = sites.alt[id];
    if (p.alt !== null && !Number.isNaN(sa) && Math.abs(sa - p.alt) > params.ALT_GATE) return;
    const d = groundDist(sites.x[id], sites.y[id], p.x, p.y, p.cosLat);
    if (d > params.R_REP) return;
    // The track has travelled at least R_REP farther along than its net displacement:
    // it has genuinely looped back rather than merely moved forward.
    if (p.s - sites.mintS[id] - d > params.R_REP) found = true;
  });
  return found;
}

/** Section 5.2: discard maximal runs of NEW samples shorter than L_MIN. */
function shortRunRule(
  samples: Sample[],
  labels: Uint8Array,
  minted: Int32Array,
  sites: SiteTable,
  params: Params,
): void {
  let i = 0;
  while (i < samples.length) {
    if (labels[i] !== P1_NEW) {
      i++;
      continue;
    }
    let j = i;
    let len = 0;
    while (j < samples.length && labels[j] === P1_NEW) {
      len += samples[j].creditM;
      j++;
    }
    if (len < params.L_MIN) {
      for (let k = i; k < j; k++) {
        if (minted[k] >= 0) sites.alive[minted[k]] = 0;
      }
    }
    i = j;
  }
}

/**
 * Section 5.3: U-turn dedup. Removes the guard-shadow duplicates minted just past an
 * out-and-back apex, while sparing contiguous travel around tight curves.
 */
function uTurnDedup(minted: Int32Array, sites: SiteTable, grid: SiteGrid, act: number, params: Params): void {
  for (let k = 0; k < minted.length; k++) {
    const s = minted[k];
    if (s < 0 || !sites.alive[s]) continue;
    const sx = sites.x[s];
    const sy = sites.y[s];
    const cosLat = Math.cos((yToLat(sy) * Math.PI) / 180);
    let hit = false;
    grid.forEachNear(sx, sy, cosLat, params.R_REP, (e) => {
      if (hit || e >= s || !sites.alive[e]) return;
      if (sites.mintAct[e] !== act) return;
      if (angDiff180(sites.bearing[e], sites.bearing[s]) > params.BEARING_TOL) return;
      // Anti-parallel: this is what separates a turnaround fold from forward progress.
      if (angDiff360(sites.bearing[e], sites.bearing[s]) <= 120) return;
      const ea = sites.alt[e];
      const sa = sites.alt[s];
      if (!Number.isNaN(ea) && !Number.isNaN(sa) && Math.abs(ea - sa) > params.ALT_GATE) return;
      const d = groundDist(sites.x[e], sites.y[e], sx, sy, cosLat);
      if (d > params.R_REP) return;
      // Fold-back: contiguous travel around any arc keeps chord/arc above 0.47, while a
      // turnaround duplicate sits near zero. Without this the pass eats tight switchbacks.
      const along = Math.abs(sites.mintS[s] - sites.mintS[e]);
      if (along > 0 && d < params.FOLDBACK_RATIO * along) hit = true;
    });
    if (hit) sites.alive[s] = 0;
  }
}

function iqr(values: number[]): number {
  if (values.length < 4) return 0;
  const v = [...values].sort((a, b) => a - b);
  const q = (f: number) => v[Math.min(v.length - 1, Math.max(0, Math.floor(f * (v.length - 1))))];
  return q(0.75) - q(0.25);
}

/**
 * Section 5.4: offset detector. Reclassifies a long run of NEW samples that is a rigid
 * lateral shift of ground already covered by an earlier activity.
 */
function offsetDetector(
  samples: Sample[],
  labels: Uint8Array,
  minted: Int32Array,
  sites: SiteTable,
  grid: SiteGrid,
  act: number,
  params: Params,
): void {
  let i = 0;
  while (i < samples.length) {
    if (labels[i] !== P1_NEW) {
      i++;
      continue;
    }
    let j = i;
    let len = 0;
    while (j < samples.length && labels[j] === P1_NEW) {
      len += samples[j].creditM;
      j++;
    }
    if (len >= params.OFFSET_MIN_RUN) {
      const dists: number[] = [];
      const dirOk: boolean[] = [];
      let matched = 0;
      for (let k = i; k < j; k++) {
        const p = samples[k];
        let bestD = Infinity;
        let bestId = -1;
        grid.forEachNear(p.x, p.y, p.cosLat, params.OFFSET_SEARCH, (id) => {
          if (!sites.alive[id] || sites.mintAct[id] === act) return;
          if (angDiff180(sites.bearing[id], p.bearing) > params.BEARING_TOL) return;
          const d = groundDist(sites.x[id], sites.y[id], p.x, p.y, p.cosLat);
          if (d < bestD && d <= params.OFFSET_SEARCH) {
            bestD = d;
            bestId = id;
          }
        });
        if (bestId >= 0) {
          matched++;
          dists.push(bestD);
          // Same direction mod 360, so opposite carriageways are never merged.
          dirOk.push(angDiff360(sites.bearing[bestId], p.bearing) <= params.OFFSET_DIR_TOL);
        }
      }
      const n = j - i;
      const frac = matched / n;
      const sameDir = dirOk.length > 0 && dirOk.filter(Boolean).length / dirOk.length >= params.OFFSET_MIN_FRAC;
      // Both ends re-converge: a GPS excursion departs from ground it knows and rejoins it,
      // whereas a genuinely new parallel road does not. Test the samples FLANKING the run --
      // the run's own endpoints sit at ~R_NEW by definition, so they can never be within R_REP.
      const endsConverge =
        i > 0 && j < samples.length && labels[i - 1] !== P1_NEW && labels[j] !== P1_NEW;
      if (frac >= params.OFFSET_MIN_FRAC && iqr(dists) < params.OFFSET_MAX_IQR && sameDir && endsConverge) {
        for (let k = i; k < j; k++) if (minted[k] >= 0) sites.alive[minted[k]] = 0;
      }
    }
    i = j;
  }
}

function processActivity(
  a: LedgerInput,
  actIdx: number,
  sites: SiteTable,
  grid: SiteGrid,
  params: Params,
): PerActivity | null {
  const pre = preprocess(a, params);
  if (!pre) return null;
  const { samples } = pre;
  const n = samples.length;

  // ---- Pass I: classify and mint eagerly ------------------------------------------------
  // Minting inside this pass, with immediate grid insertion, is what makes an out-and-back
  // count once and 25 laps of a track credit ~400 m rather than 10 km.
  const labels = new Uint8Array(n);
  const minted = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = samples[i];
    const c = nearestCandidate(p, params.R_NEW, sites, grid, {
      applyGuard: true,
      currentAct: actIdx,
      params,
    });
    if (c && c.dist <= params.R_REP) {
      labels[i] = P1_REPEAT;
    } else if (c) {
      labels[i] = P1_AMBIGUOUS;
    } else if (wrappedBack(p, sites, grid, actIdx, params)) {
      labels[i] = P1_REPEAT;
    } else {
      labels[i] = P1_NEW;
      const id = sites.push(p, actIdx, a.startTs, i);
      grid.insert(p.x, p.y, id);
      minted[i] = id;
    }
  }

  // ---- Stage 3: tombstone passes ---------------------------------------------------------
  shortRunRule(samples, labels, minted, sites, params);
  if (params.uTurnDedup) uTurnDedup(minted, sites, grid, actIdx, params);
  if (params.offsetDetector) offsetDetector(samples, labels, minted, sites, grid, actIdx, params);

  // ---- Pass II: attribution --------------------------------------------------------------
  // Site references are assigned only now, after all tombstoning, which removes an entire
  // class of dangling-reference bugs at the cost of one extra grid query per sample.
  const outLabels = new Uint8Array(n);
  const siteIds = new Int32Array(n).fill(-1);
  const touched = new Set<number>();
  for (let i = 0; i < n; i++) {
    const p = samples[i];
    const c = nearestCandidate(p, params.R_NEW, sites, grid, {
      applyGuard: false,
      currentAct: actIdx,
      params,
    });
    if (!c) {
      outLabels[i] = LABEL_NONE;
      continue;
    }
    siteIds[i] = c.id;
    touched.add(c.id);
    if (sites.mintAct[c.id] === actIdx && sites.mintSample[c.id] === i) outLabels[i] = LABEL_NEW;
    else if (c.dist <= params.R_REP) outLabels[i] = LABEL_REPEAT;
    // Ambiguous samples still record a touch: the pass happened, and it must register on the
    // map and in the distinct-ground number even though it earns no credit.
    else outLabels[i] = LABEL_AMBIGUOUS;
  }

  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const p of samples) {
    const lng = xToLng(p.x);
    const lat = yToLat(p.y);
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  return {
    summary: {
      idx: actIdx,
      stravaId: a.id,
      name: a.name,
      startTs: a.startTs,
      startDateLocal: a.startDateLocal,
      sportType: a.sportType,
      group: a.sportGroup,
      distanceM: a.distanceM,
      newGroundM: 0,
      bbox: [minLng, minLat, maxLng, maxLat],
    },
    samples,
    labels: outLabels,
    siteIds,
    touches: Uint32Array.from([...touched].sort((x, y) => x - y)),
  };
}

export function runLedger(input: LedgerInput[], params: Params): BuiltLedger {
  const sorted = [...input].sort((a, b) => a.startTs - b.startTs || a.id - b.id);
  const sites = new SiteTable();
  const grid = new SiteGrid(params.CELL_MERC);
  const per: PerActivity[] = [];

  for (const a of sorted) {
    const r = processActivity(a, per.length, sites, grid, params);
    if (r) per.push(r);
  }

  // ---- Stage 4: compaction ---------------------------------------------------------------
  // Every touch list must be remapped through the same table. Skipping this is silent
  // corruption: ids still resolve to real sites, so nothing throws, but everything is wrong.
  const remap = new Int32Array(sites.n).fill(-1);
  let live = 0;
  for (let i = 0; i < sites.n; i++) if (sites.alive[i]) remap[i] = live++;

  const sx = new Float64Array(live);
  const sy = new Float64Array(live);
  const sb = new Uint8Array(live);
  const sc = new Float32Array(live);
  const st = new Uint32Array(live);
  const sa = new Uint32Array(live);
  for (let i = 0; i < sites.n; i++) {
    const j = remap[i];
    if (j < 0) continue;
    sx[j] = sites.x[i];
    sy[j] = sites.y[i];
    sb[j] = sites.bearing[i];
    sc[j] = sites.creditM[i];
    st[j] = sites.mintTs[i];
    sa[j] = sites.mintAct[i];
  }

  const nGroups = SPORT_GROUPS.length;
  const firstTsByGroup: Uint32Array[] = [];
  for (let g = 0; g < nGroups; g++) firstTsByGroup.push(new Uint32Array(live).fill(0xffffffff));

  const actOffsets = new Uint32Array(per.length + 1);
  const trackOffsets = new Uint32Array(per.length + 1);
  let touchTotal = 0;
  let pointTotal = 0;
  for (let i = 0; i < per.length; i++) {
    // Recount touches after remapping: Pass II only attributes to live sites, so nothing
    // should drop, but assert rather than tolerate.
    let kept = 0;
    for (const t of per[i].touches) if (remap[t] >= 0) kept++;
    if (kept !== per[i].touches.length) {
      throw new Error(`activity ${i}: ${per[i].touches.length - kept} touches point at tombstoned sites`);
    }
    touchTotal += kept;
    pointTotal += per[i].samples.length;
    actOffsets[i + 1] = touchTotal;
    trackOffsets[i + 1] = pointTotal;
  }

  const siteIds = new Uint32Array(touchTotal);
  const px = new Int32Array(pointTotal);
  const py = new Int32Array(pointTotal);
  const flag = new Uint8Array(pointTotal);

  let ti = 0;
  let pi = 0;
  let uniqueMeters = 0;
  let totalMeters = 0;
  let minTs = Infinity;
  let maxTs = -Infinity;
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  for (let i = 0; i < per.length; i++) {
    const p = per[i];
    for (const t of p.touches) {
      const j = remap[t];
      if (j < 0) continue;
      siteIds[ti++] = j;
      const g = p.summary.group;
      if (firstTsByGroup[g][j] === 0xffffffff) firstTsByGroup[g][j] = p.summary.startTs;
    }
    let prevLeg = -1;
    for (let k = 0; k < p.samples.length; k++) {
      const s = p.samples[k];
      px[pi] = Math.round(s.x * 100);
      py[pi] = Math.round(s.y * 100);
      flag[pi] = p.labels[k] | (s.leg !== prevLeg ? 1 << 2 : 0);
      prevLeg = s.leg;
      pi++;
      totalMeters += s.creditM;
    }
    minTs = Math.min(minTs, p.summary.startTs);
    maxTs = Math.max(maxTs, p.summary.startTs);
    minLng = Math.min(minLng, p.summary.bbox[0]);
    minLat = Math.min(minLat, p.summary.bbox[1]);
    maxLng = Math.max(maxLng, p.summary.bbox[2]);
    maxLat = Math.max(maxLat, p.summary.bbox[3]);
  }

  for (let j = 0; j < live; j++) uniqueMeters += sc[j];

  // Per-activity new ground: the surviving sites that activity minted.
  const newByAct = new Float64Array(per.length);
  for (let j = 0; j < live; j++) newByAct[sa[j]] += sc[j];
  const activities = per.map((p, i) => ({ ...p.summary, newGroundM: newByAct[i] }));

  return {
    sites: { n: live, x: sx, y: sy, bearing: sb, creditM: sc, mintTs: st, mintAct: sa, firstTsByGroup },
    touches: { actOffsets, siteIds },
    tracks: { trackOffsets, px, py, flag },
    activities,
    totals: { uniqueMeters, totalMeters },
    bounds: {
      minLng: Number.isFinite(minLng) ? minLng : 0,
      minLat: Number.isFinite(minLat) ? minLat : 0,
      maxLng: Number.isFinite(maxLng) ? maxLng : 0,
      maxLat: Number.isFinite(maxLat) ? maxLat : 0,
    },
    timeRange: {
      minTs: Number.isFinite(minTs) ? minTs : 0,
      maxTs: Number.isFinite(maxTs) ? maxTs : 0,
    },
  };
}
