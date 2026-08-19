/** Timeline histogram, two-handle brush, presets, and playback transport. SPEC.md section 6.4. */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../state/store.js';
import {
  cueAt,
  routeDrawSeconds,
  stepReplay,
  traversedSpanSeconds,
  PLAYBACK_SECONDS,
} from '../lib/playback.js';

const DAY = 86400;
const WEEK = 7 * DAY;

/**
 * Floor a timestamp to the Monday that starts its week, in UTC.
 *
 * The epoch fell on a Thursday, so the offset lines the arithmetic up with Monday rather than
 * with 1 January 1970.
 */
function weekStart(ts: number): number {
  return Math.floor((ts + 3 * DAY) / WEEK) * WEEK - 3 * DAY;
}


/** Local-calendar year boundaries derived from the athlete's own start_date_local. */
function yearsOf(activities: { startDateLocal: string; startTs: number }[]): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  for (const a of activities) {
    const y = new Date(a.startDateLocal).getUTCFullYear();
    const cur = m.get(y);
    if (!cur) m.set(y, [a.startTs, a.startTs]);
    else m.set(y, [Math.min(cur[0], a.startTs), Math.max(cur[1], a.startTs)]);
  }
  return m;
}

export function Scrubber() {
  const {
    activities, groups, t0, t1, minTs, maxTs, playing, speed, skipEmptyDays, playhead, actSpans,
    replayReverse, skipOutsideBounds, viewBounds,
  } = useStore();
  const set = useStore((s) => s.set);
  const setWindow = useStore((s) => s.setWindow);
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<'t0' | 't1' | 'mid' | null>(null);
  const dragStart = useRef({ x: 0, t0: 0, t1: 0 });

  const span = Math.max(1, maxTs + DAY - minTs);
  const pct = (t: number) => ((t - minTs) / span) * 100;

  // The histogram responds to the sport filter but not to the time window: it is the map of
  // the territory being scrubbed through.
  const bars = useMemo(() => {
    if (!activities.length || !Number.isFinite(minTs)) return [];
    const groupSet = new Set(groups);
    const buckets = new Map<number, number>();
    for (const a of activities) {
      if (!groupSet.has(a.group)) continue;
      const d = new Date(a.startDateLocal);
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
      const key = weekStart(day);
      buckets.set(key, (buckets.get(key) ?? 0) + a.distanceM);
    }

    // Emit a CONTIGUOUS week series, including weeks with no activity. Skipping the empty ones
    // and letting flexbox space the rest evenly would put each bar at its index position while
    // the brush sits at its time position -- the two axes drift apart and the highlight stops
    // matching the window. Every bar is positioned by time below, on the brush's own scale.
    const rows: Array<{ ts: number; tsEnd: number; m: number }> = [];
    for (let ts = weekStart(minTs); ts <= maxTs + DAY; ts += WEEK) {
      rows.push({ ts, tsEnd: ts + WEEK, m: buckets.get(ts) ?? 0 });
    }
    const max = Math.max(1, ...rows.map((r) => r.m));
    return rows.map((r) => ({ ts: r.ts, tsEnd: r.tsEnd, h: r.m / max }));
  }, [activities, groups, minTs, maxTs]);

  const years = useMemo(() => yearsOf(activities), [activities]);

  const posToTs = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return minTs;
      const r = el.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return minTs + f * span;
    },
    [minTs, span],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      const ts = posToTs(e.clientX);
      if (drag.current === 't0') setWindow(ts, t1);
      else if (drag.current === 't1') setWindow(t0, ts);
      else {
        const el = trackRef.current;
        if (!el) return;
        const dt = ((e.clientX - dragStart.current.x) / el.getBoundingClientRect().width) * span;
        const w = dragStart.current.t1 - dragStart.current.t0;
        let n0 = dragStart.current.t0 + dt;
        n0 = Math.max(minTs, Math.min(maxTs + DAY - w, n0));
        setWindow(n0, n0 + w);
      }
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // A gesture the browser takes over for scrolling ends in `pointercancel` and never
    // `pointerup`. Listening only for the latter latches the drag, and every later touch
    // anywhere on the page keeps scrubbing the window.
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [posToTs, setWindow, t0, t1, span, minTs, maxTs]);

  /**
   * The routes this replay will draw, in order, each with the span it actually covered.
   *
   * Activities that minted no ground -- every metre of them already covered -- are dropped:
   * dwelling on a route that will not appear is indistinguishable from the replay having stalled.
   */
  const reel = useMemo(() => {
    if (!actSpans) return [] as { from: number; to: number }[];
    const g = new Set(groups);
    const vb = skipOutsideBounds ? viewBounds : null;
    const out: { from: number; to: number }[] = [];
    for (const a of activities) {
      if (!g.has(a.group)) continue;
      // Dropped when its bounding box misses the map entirely: dwelling on a ride in another
      // state, drawing off-screen, is indistinguishable from the replay having stalled.
      if (vb && (a.bbox[2] < vb[0] || a.bbox[0] > vb[2] || a.bbox[3] < vb[1] || a.bbox[1] > vb[3])) {
        continue;
      }
      const from = actSpans[2 * a.idx];
      const to = actSpans[2 * a.idx + 1];
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      out.push({ from, to });
    }
    out.sort((x, y) => x.from - y.from);
    return out;
  }, [activities, groups, actSpans, skipOutsideBounds, viewBounds]);

  /** Start times only, for the histogram-independent pacing maths. */
  const starts = useMemo(() => reel.map((r) => r.from), [reel]);

  /** Where the replay is within the reel: which route, and how far through drawing it. */
  const cue = useRef<{ i: number; t: number } | null>(null);

  /**
   * Playback walks the reel one route at a time; the selection itself never moves.
   *
   * The playhead is paced to activities rather than to the calendar, which is what makes
   * exactly one route ever mid-draw. Inside a route it crawls across that route's own span, so
   * the line visibly grows; between routes it crosses the gap quickly -- instantly when empty
   * days are being skipped, which is what makes the "always exactly one" guarantee hold.
   */
  useEffect(() => {
    if (!playing) return;

    const inWindow = reel.filter((r) => r.to >= t0 && r.from <= t1);
    if (inWindow.length === 0) {
      set({ playing: false, playhead: null });
      return;
    }

    const drawS = routeDrawSeconds(inWindow.length);
    // Whatever wall-clock budget is left over after the draws pays for the gaps, so a run with
    // skipping off still lands near PLAYBACK_SECONDS instead of running away.
    const gapBudget = Math.max(0, PLAYBACK_SECONDS - inWindow.length * drawS);
    const gapSpan = Math.max(
      1,
      traversedSpanSeconds(t0, t1, starts, false) - inWindow.reduce((n, r) => n + (r.to - r.from), 0),
    );

    // Derived from the playhead every time, never carried across.
    //
    // The cue is an index, and the reel it indexes is rebuilt whenever new history lands --
    // and a Strava sync arrives NEWEST FIRST, so each batch inserts older activities at the
    // front and shifts every index. A carried-over index then points at a different route and
    // the replay jumps somewhere else in time. The playhead is a timestamp and means the same
    // thing whatever the reel looks like, so it is the thing worth trusting.
    // Walking backwards is the same walk over a reversed reel, with each route crawled from
    // its end to its start -- so time runs backwards throughout rather than only between routes.
    const order = replayReverse ? [...inWindow].reverse() : inWindow;
    cue.current = cueAt(order, useStore.getState().playhead, replayReverse);
    if (useStore.getState().playhead === null) {
      // Otherwise the query runs once with no playhead, which means "show the whole selection",
      // and the map flashes complete before collapsing back to the first route.
      const first = order[cue.current.i];
      set({ playhead: replayReverse ? first.to : first.from });
    }

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000) * speed;
      last = now;
      const c = cue.current;
      if (!c) return;

      const gap = c.i + 1 < order.length
        ? Math.abs(replayReverse ? order[c.i].from - order[c.i + 1].to : order[c.i + 1].from - order[c.i].to)
        : 0;
      const gapS = skipEmptyDays ? 0 : (gap / gapSpan) * gapBudget;

      const s = stepReplay(order, c, dt, drawS, gapS, replayReverse);
      cue.current = s.cue;
      if (s.done) {
        set({ playhead: null, playing: false });
        cue.current = null;
        return;
      }
      set({ playhead: s.playhead });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, set, t0, t1, reel, starts, skipEmptyDays, replayReverse]);

  const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

  return (
    <div className="panel" style={{ padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button
          className="ghost"
          style={{ width: 34 }}
          onClick={() => set({ playing: !playing })}
          aria-label={playing ? 'Pause' : playhead === null || playhead <= t0 ? 'Play' : 'Resume'}
          title={
            playing ? 'Pause' : playhead === null || playhead <= t0 ? 'Play' : 'Resume from here'
          }
        >
          {playing ? '❙❙' : '▶'}
        </button>
        {/* Distinct from play, because resuming and starting over are different intentions and
            one button cannot express both. It stops as well as rewinds: leaving it running
            would mean the transport reads "pause" over a map that has just gone blank. */}
        <button
          className="ghost"
          style={{ width: 34 }}
          onClick={() => {
            cue.current = null;
            set({ playhead: t0, playing: false });
          }}
          disabled={!playing && (playhead === null || playhead <= t0)}
          aria-label="Back to the start of the selection"
          title="Back to the start of the selection"
        >
          ↺
        </button>
        {[0.5, 1, 2, 4].map((s) => (
          <button key={s} className="chip" aria-pressed={speed === s} onClick={() => set({ speed: s })}>
            {s}x
          </button>
        ))}
        <label className="check" style={{ margin: 0 }} title="Compress stretches with no activities">
          <input
            type="checkbox"
            checked={skipEmptyDays}
            onChange={(e) => set({ skipEmptyDays: e.target.checked })}
          />
          <span>Skip empty days</span>
        </label>
        <label
          className="check"
          style={{ margin: 0 }}
          title="Pass over activities that fall entirely outside the map view"
        >
          <input
            type="checkbox"
            checked={skipOutsideBounds}
            onChange={(e) => set({ skipOutsideBounds: e.target.checked })}
          />
          <span>Skip out of view</span>
        </label>
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(t0)} — {fmt(playhead ?? t1)}
        </span>
      </div>

      <div
        ref={trackRef}
        // Without this the browser claims a touch drag for scrolling the sheet, and the brush
        // follows the finger only until it decides otherwise.
        style={{ position: 'relative', height: 46, cursor: 'crosshair', userSelect: 'none', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (drag.current) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const ts = posToTs(e.clientX);
          // Grab the nearer handle.
          if (Math.abs(ts - t0) < Math.abs(ts - t1)) {
            drag.current = 't0';
            setWindow(ts, t1);
          } else {
            drag.current = 't1';
            setWindow(t0, ts);
          }
        }}
      >
        <div style={{ position: 'absolute', inset: 0 }}>
          {bars.map((b) => {
            const left = pct(b.ts);
            const right = pct(b.tsEnd);
            // A month counts as selected when it overlaps the window at all, which is what
            // makes the lit bars line up with the brush edges rather than with a bar boundary.
            const selected = b.tsEnd > t0 && b.ts < t1;
            return (
              <div
                key={b.ts}
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: `${left}%`,
                  width: `calc(${Math.max(0, right - left)}% - 1px)`,
                  // A week is a few pixels wide; without a floor the separator eats the bar.
                  minWidth: 1,
                  height: `${Math.max(2, b.h * 100)}%`,
                  background: 'var(--text-muted)',
                  opacity: selected ? 0.55 : 0.16,
                  borderRadius: '2px 2px 0 0',
                }}
              />
            );
          })}
        </div>

        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${pct(t0)}%`,
            width: `${Math.max(0.4, pct(t1) - pct(t0))}%`,
            background: 'rgba(57,135,229,0.16)',
            border: '1px solid var(--series-1)',
            borderRadius: 3,
            cursor: 'grab',
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            drag.current = 'mid';
            dragStart.current = { x: e.clientX, t0, t1 };
          }}
        />
        {/* Where the replay has reached. Drawn over the brush rather than replacing it, which
            is the whole point: the selection stays exactly where it was put. */}
        {playhead !== null && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              top: -3,
              bottom: -3,
              left: `calc(${pct(playhead)}% - 1px)`,
              width: 2,
              background: 'var(--frontier)',
              borderRadius: 1,
              pointerEvents: 'none',
              boxShadow: '0 0 6px var(--frontier)',
            }}
          />
        )}

        {(['t0', 't1'] as const).map((h) => (
          <div
            key={h}
            className="scrub-handle"
            style={{
              position: 'absolute',
              top: -2,
              bottom: -2,
              left: `calc(${pct(h === 't0' ? t0 : t1)}% - 4px)`,
              width: 8,
              background: 'var(--series-1)',
              borderRadius: 3,
              cursor: 'ew-resize',
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = h;
            }}
          />
        ))}
      </div>

      <div className="preset-row" style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="chip" onClick={() => setWindow(minTs, maxTs + DAY)}>
          All time
        </button>
        <button
          className="chip"
          onClick={() => setWindow(Math.max(minTs, maxTs - 365 * DAY), maxTs + DAY)}
        >
          Last 12 months
        </button>
        {[...years.keys()]
          .sort((a, b) => b - a)
          .slice(0, 12)
          .map((y) => (
            <button
              key={y}
              className="chip"
              onClick={() => {
                // A year chip spans the first and last activity the athlete's own calendar puts
                // in that year, which is still an ordinary UTC window the fold understands.
                const [a, b] = years.get(y)!;
                setWindow(a, b);
              }}
            >
              {y}
            </button>
          ))}
      </div>
    </div>
  );
}
