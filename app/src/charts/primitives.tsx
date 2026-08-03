/**
 * Hand-rolled SVG chart primitives. See SPEC.md section 6.5.
 *
 * No chart library and no external dependency: the charts here are four fixed forms, and a
 * library would cost more bytes than it saves. The house rules these pieces exist to enforce:
 * one y-axis only, recessive grid and axes, thin marks, text in text tokens (never a series
 * colour), and a hover tooltip plus a table toggle on every chart.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';

/** The plot rectangle, in SVG user units. */
export interface Plot {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface Tick {
  /** Position along the axis, in SVG user units. */
  pos: number;
  label: string;
}

/**
 * Width from a ResizeObserver so charts reflow with the drawer. Height stays fixed per chart:
 * these are wide-and-short forms, and a height that chased the container would jitter.
 */
export function useChartSize(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.clientWidth));
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.round(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}

/**
 * Round tick values over a [0, max] domain, stepping by 1, 2 or 5 times a power of ten. The
 * last tick is always at or above `max`, so callers can use it as the scale top and get an
 * axis that ends on a clean number.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const raw = max / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  // Geometric-midpoint thresholds, so the chosen step is the one nearest `raw` in ratio. Using
  // the arithmetic midpoints instead rounds up too eagerly and leaves the top third empty.
  const step = (norm > 7.07 ? 10 : norm > 3.16 ? 5 : norm > 1.41 ? 2 : 1) * mag;
  const out: number[] = [];
  // Guard the loop against a pathological step rather than trusting the arithmetic above.
  for (let v = 0, i = 0; v < max + step * 1e-6 && i < 40; v += step, i++) out.push(round(v));
  const top = out[out.length - 1];
  if (top === undefined || top < max) out.push(round((top ?? 0) + step));
  return out;
}

/** Repeated addition of a decimal step drifts; snap it back before it reaches a label. */
function round(v: number): number {
  return Number(v.toFixed(10));
}

/**
 * Axis-tick text, bare: the unit is named once, in the chart's subtitle. The scale is chosen
 * from the largest tick and then applied to all of them — deciding per value gives an axis
 * that reads "5,000, 10k, 15k", which looks like two different scales.
 */
export function tickFormatter(max: number): (v: number) => string {
  if (max >= 10000) return (v) => (v === 0 ? '0' : `${Number((v / 1000).toFixed(1)).toLocaleString()}k`);
  if (max >= 10) return (v) => v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return (v) => (v === 0 ? '0' : v.toFixed(1));
}

interface AxisProps {
  orientation: 'x' | 'y';
  ticks: Tick[];
  plot: Plot;
}

/** A single axis. The y-axis draws no domain line — the gridlines already carry the scale. */
export function Axis({ orientation, ticks, plot }: AxisProps) {
  if (orientation === 'x') {
    return (
      <g className="chart-axis">
        <line x1={plot.x0} x2={plot.x1} y1={plot.y1} y2={plot.y1} />
        {ticks.map((t) => (
          <text key={`${t.label}@${t.pos}`} x={t.pos} y={plot.y1 + 14} textAnchor="middle">
            {t.label}
          </text>
        ))}
      </g>
    );
  }
  return (
    <g className="chart-axis">
      {ticks.map((t) => (
        <text key={`${t.label}@${t.pos}`} x={plot.x0 - 8} y={t.pos + 3.5} textAnchor="end">
          {t.label}
        </text>
      ))}
    </g>
  );
}

/** Horizontal gridlines at the y ticks. Hairline, solid, and deliberately recessive. */
export function GridLines({ ticks, plot }: { ticks: Tick[]; plot: Plot }) {
  return (
    <g className="chart-grid">
      {ticks.map((t) => (
        <line key={`${t.label}@${t.pos}`} x1={plot.x0} x2={plot.x1} y1={t.pos} y2={t.pos} />
      ))}
    </g>
  );
}

interface TooltipProps {
  /** Anchor position in pixels, relative to the positioned chart body. */
  x: number;
  y: number;
  /** Container width, used to flip the tooltip before it runs off the right edge. */
  width: number;
  /** Sit above the anchor instead of below it, so a mark near the baseline is not overflowed. */
  above?: boolean;
  children: ReactNode;
}

export function Tooltip({ x, y, width, above = false, children }: TooltipProps) {
  const flip = x > width * 0.55;
  const dx = flip ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)';
  return (
    <div
      className="chart-tip"
      role="status"
      style={{ left: x, top: y, transform: above ? `${dx} translateY(-100%)` : dx }}
    >
      {children}
    </div>
  );
}

interface FigureProps {
  title: string;
  subtitle?: string;
  /**
   * The same numbers as an HTML table. When supplied, a chart/table toggle appears. This is
   * the accessibility relief required by SPEC 6.5: a table is the only form a screen reader
   * can read, regardless of how well the palette scores.
   */
  table?: ReactNode;
  /** Rendered above the plot, below the header: legends, notes. */
  aside?: ReactNode;
  children: ReactNode;
}

export function Figure({ title, subtitle, table, aside, children }: FigureProps) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className="chart-figure">
      <header className="chart-head">
        <div>
          <h3 className="chart-title">{title}</h3>
          {subtitle !== undefined && <p className="chart-sub">{subtitle}</p>}
        </div>
        {table !== undefined && (
          <button
            className="ghost chart-toggle"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? 'Chart' : 'Table'}
          </button>
        )}
      </header>
      {!showTable && aside}
      <div className="chart-body">{showTable && table !== undefined ? table : children}</div>
    </section>
  );
}
