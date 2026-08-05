/** Timeline histogram, two-handle brush, presets, and playback transport. SPEC.md section 6.4. */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../state/store.js';
import {
  MAX_EMPTY_GAP_S,
  medianGapSeconds,
  PLAYBACK_SECONDS,
  routeDrawSpanSeconds,
  traversedSpanSeconds,
} from '../lib/playback.js';

const DAY = 86400;


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
    activities, groups, t0, t1, minTs, maxTs, playing, speed, windowMode, skipEmptyDays, playhead,
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
      const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth()) / 1000;
      buckets.set(key, (buckets.get(key) ?? 0) + a.distanceM);
    }

    // Emit a CONTIGUOUS month series, including months with no activity. Skipping empty months
    // and letting flexbox space the rest evenly would put each bar at its index position while
    // the brush sits at its time position -- the two axes drift apart and the highlight stops
    // matching the window. Every bar is positioned by time below, on the brush's own scale.
    const start = new Date(minTs * 1000);
    const end = new Date((maxTs + DAY) * 1000);
    const rows: Array<{ ts: number; tsEnd: number; m: number }> = [];
    for (
      let y = start.getUTCFullYear(), mo = start.getUTCMonth();
      Date.UTC(y, mo) <= Date.UTC(end.getUTCFullYear(), end.getUTCMonth());
      mo === 11 ? ((y += 1), (mo = 0)) : (mo += 1)
    ) {
      const ts = Date.UTC(y, mo) / 1000;
      const tsEnd = Date.UTC(mo === 11 ? y + 1 : y, mo === 11 ? 0 : mo + 1) / 1000;
      rows.push({ ts, tsEnd, m: buckets.get(ts) ?? 0 });
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
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [posToTs, setWindow, t0, t1, span, minTs, maxTs]);

  /** Start times of the activities actually on screen, ascending. */
  const starts = useMemo(() => {
    const g = new Set(groups);
    return activities
      .filter((a) => g.has(a.group))
      .map((a) => a.startTs)
      .sort((x, y) => x - y);
  }, [activities, groups]);

  /**
   * Playback moves the playhead across the selection; the selection itself never moves.
   *
   * The rate is normalised so a selection plays in about PLAYBACK_SECONDS at 1x whether it
   * covers a month or ten years, pro-rated by elapsed wall clock so it is independent of frame
   * rate. Empty stretches are compressed when asked, which is why the pacing is measured
   * against the span actually traversed rather than the raw one.
   */
  useEffect(() => {
    if (!playing) return;

    const from = t0;
    const to = Math.max(t0 + DAY, t1);
    const span = Math.max(DAY, traversedSpanSeconds(from, to, starts, skipEmptyDays));
    set({ drawSpanS: routeDrawSpanSeconds(span, speed, medianGapSeconds(starts)) });

    // Resuming continues from where it stopped; starting fresh begins at the selection's edge.
    if (useStore.getState().playhead === null) set({ playhead: from });

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const advance = dt * speed * (span / PLAYBACK_SECONDS);
      const at = useStore.getState().playhead ?? from;

      let next = at + advance;
      if (skipEmptyDays) {
        const upcoming = starts.find((x) => x > at);
        if (upcoming === undefined || upcoming >= to) {
          // Nothing left inside the selection to draw, so the tail is empty by definition.
          // Without this the jump could land on an activity BEYOND the selection and overshoot
          // the end, which ended the replay the instant it started -- exactly what restarting
          // into a stretch with no activities ahead of it looked like.
          next = to;
        } else if (upcoming - MAX_EMPTY_GAP_S > next) {
          // Nothing between here and the next one, and further off than we will traverse:
          // jump to just short of it rather than sweeping empty ground.
          next = upcoming - MAX_EMPTY_GAP_S;
        }
      }

      if (next >= to) {
        // Finished: drop the playhead so the map shows the selection whole again.
        set({ playhead: null, playing: false });
        return;
      }
      set({ playhead: next });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, set, t0, t1, starts, skipEmptyDays]);

  const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

  return (
    <div className="panel" style={{ left: 12, right: 292, bottom: 12, padding: '10px 14px' }}>
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
          onClick={() => set({ playhead: t0, playing: false })}
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
        <select
          className="chip"
          value={windowMode}
          onChange={(e) => set({ windowMode: e.target.value as 'expanding' | 'sliding' })}
          style={{ background: 'var(--inset-bg)', color: 'var(--text-secondary)' }}
        >
          <option value="expanding">Expanding</option>
          <option value="sliding">Sliding</option>
        </select>
        <label className="check" style={{ margin: 0 }} title="Compress stretches with no activities">
          <input
            type="checkbox"
            checked={skipEmptyDays}
            onChange={(e) => set({ skipEmptyDays: e.target.checked })}
          />
          <span>Skip empty days</span>
        </label>
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(t0)} — {fmt(playhead ?? t1)}
        </span>
      </div>

      <div
        ref={trackRef}
        style={{ position: 'relative', height: 46, cursor: 'crosshair', userSelect: 'none' }}
        onPointerDown={(e) => {
          if (drag.current) return;
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
              drag.current = h;
            }}
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 5, marginTop: 8, flexWrap: 'wrap' }}>
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
