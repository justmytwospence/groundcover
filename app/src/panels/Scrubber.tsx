/** Timeline histogram, two-handle brush, presets, and playback transport. SPEC.md section 6.4. */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from '../state/store.js';

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
    if (!activities.length) return [];
    const groupSet = new Set(groups);
    const buckets = new Map<number, number>();
    for (const a of activities) {
      if (!groupSet.has(a.group)) continue;
      const d = new Date(a.startDateLocal);
      const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth()) / 1000;
      buckets.set(key, (buckets.get(key) ?? 0) + a.distanceM);
    }
    const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    return rows.map(([ts, m]) => ({ ts, h: m / max }));
  }, [activities, groups]);

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

  // Playback: one month of history per real second at 1x, pro-rated by elapsed wall clock so
  // the rate is independent of frame rate.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const advance = dt * speed * 30 * DAY;
      const s = useStore.getState();
      if (s.windowMode === 'expanding') {
        const next = s.t1 + advance;
        if (next >= s.maxTs + DAY) {
          set({ t1: s.maxTs + DAY, playing: false });
          return;
        }
        set({ t1: next });
      } else {
        const w = s.t1 - s.t0;
        const next = s.t0 + advance;
        if (next + w >= s.maxTs + DAY) {
          set({ t0: s.maxTs + DAY - w, t1: s.maxTs + DAY, playing: false });
          return;
        }
        set({ t0: next, t1: next + w });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, set]);

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
          style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--text-secondary)' }}
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
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
          {bars.map((b) => (
            <div
              key={b.ts}
              style={{
                flex: 1,
                height: `${Math.max(2, b.h * 100)}%`,
                background: 'var(--text-muted)',
                opacity: b.ts >= t0 && b.ts <= t1 ? 0.55 : 0.16,
                borderRadius: '2px 2px 0 0',
                minWidth: 1,
              }}
            />
          ))}
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
