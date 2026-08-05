/** Timeline histogram, two-handle brush, presets, and playback transport. SPEC.md section 6.4. */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../state/store.js';

const DAY = 86400;
/** Seconds of real time to replay the whole history at 1x. */
/**
 * Wall-clock seconds a full history takes to play at 1x.
 *
 * Every speed chip is a multiplier on this, so raising it slows the whole set at once and the
 * labels keep meaning what they say relative to each other.
 */
const PLAYBACK_SECONDS = 90;

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
  const { activities, groups, t0, t1, minTs, maxTs, playing, speed, windowMode } = useStore();
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

  // Playback. The rate is normalised so a full history plays in about PLAYBACK_SECONDS at 1x
  // whether it spans one year or ten, pro-rated by elapsed wall clock so it is independent of
  // frame rate.
  useEffect(() => {
    if (!playing) return;
    const end = maxTs + DAY;
    const span = Math.max(DAY, end - minTs);

    // Pressing play with the window already at the end -- which is the default, all-time view
    // -- would run past the end on the very first frame and stop instantly, looking exactly
    // like the button does nothing. Rewind and replay from the start instead.
    const s0 = useStore.getState();
    if (s0.t1 >= end - 1) {
      if (s0.windowMode === 'expanding') set({ t0: minTs, t1: minTs });
      else set({ t0: minTs, t1: Math.min(end, minTs + (s0.t1 - s0.t0)) });
    }

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const advance = dt * speed * (span / PLAYBACK_SECONDS);
      const s = useStore.getState();
      if (s.windowMode === 'expanding') {
        const next = s.t1 + advance;
        if (next >= end) {
          set({ t1: end, playing: false });
          return;
        }
        set({ t1: next });
      } else {
        const w = s.t1 - s.t0;
        const next = s.t0 + advance;
        if (next + w >= end) {
          set({ t0: end - w, t1: end, playing: false });
          return;
        }
        set({ t0: next, t1: next + w });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, set, minTs, maxTs]);

  const fmt = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

  return (
    <div className="panel" style={{ left: 12, right: 292, bottom: 12, padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <button
          className="ghost"
          style={{ width: 34 }}
          onClick={() => set({ playing: !playing })}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? '❙❙' : '▶'}
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
        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(t0)} — {fmt(t1)}
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
