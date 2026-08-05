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
const PLAYBACK_SECONDS = 180;

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

  /**
   * The span a running animation covers, captured the moment play begins and held until it
   * finishes. Its presence is what separates resuming a paused animation from starting one.
   */
  const playRange = useRef<{ from: number; to: number; width: number } | null>(null);
  /** The last window the animation itself wrote, so a manual change can be told apart. */
  const lastAnimated = useRef<{ t0: number; t1: number } | null>(null);

  /**
   * Moving the brush or picking a preset while paused abandons the captured span, so the next
   * play starts from the new selection instead of resuming an animation the user has scrubbed
   * away from. Pausing alone must not do this, which is why it compares against the values the
   * animation last wrote rather than simply reacting to `playing` going false.
   */
  useEffect(() => {
    if (playing) return;
    const la = lastAnimated.current;
    if (!la || la.t0 !== t0 || la.t1 !== t1) playRange.current = null;
  }, [t0, t1, playing]);

  // Playback. The rate is normalised so the selected span plays in about PLAYBACK_SECONDS at 1x
  // whether it covers one month or ten years, pro-rated by elapsed wall clock so it is
  // independent of frame rate.
  useEffect(() => {
    if (!playing) return;
    const end = maxTs + DAY;
    const s0 = useStore.getState();

    // A fresh play rewinds to the beginning of what is currently selected. Without this,
    // pressing play on a window sitting at its end runs past it on the very first frame and
    // stops instantly, which looks exactly like the button doing nothing.
    if (!playRange.current) {
      if (s0.windowMode === 'expanding') {
        // The selection is the span: choose 2023 and you watch 2023 fill in, not 2023 onwards.
        const from = s0.t0;
        const to = s0.t1 >= end - 1 ? end : s0.t1;
        playRange.current = { from, to, width: 0 };
        set({ t0: from, t1: from });
      } else {
        // A sliding window has no room to move inside a selection of its own width, so the
        // selection sets the width and the sweep covers the whole history.
        const width = Math.max(DAY, s0.t1 - s0.t0);
        playRange.current = { from: minTs, to: end, width };
        set({ t0: minTs, t1: Math.min(end, minTs + width) });
      }
    }

    const range = playRange.current;
    const span = Math.max(DAY, range.to - range.from);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      const advance = dt * speed * (span / PLAYBACK_SECONDS);
      const s = useStore.getState();
      if (s.windowMode === 'expanding') {
        const next = s.t1 + advance;
        if (next >= range.to) {
          lastAnimated.current = { t0: range.from, t1: range.to };
          set({ t1: range.to, playing: false });
          playRange.current = null;
          return;
        }
        lastAnimated.current = { t0: s.t0, t1: next };
        set({ t1: next });
      } else {
        const w = range.width;
        const next = s.t0 + advance;
        if (next + w >= range.to) {
          lastAnimated.current = { t0: range.to - w, t1: range.to };
          set({ t0: range.to - w, t1: range.to, playing: false });
          playRange.current = null;
          return;
        }
        lastAnimated.current = { t0: next, t1: next + w };
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
