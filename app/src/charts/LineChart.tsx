/**
 * Multi-series line chart. See SPEC.md section 6.5 chart 1.
 *
 * One y-axis, always. Two measures of different scale get two charts or a common base — never
 * a second axis, which is the single most misread thing a chart can do.
 */

import { useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Axis, Figure, GridLines, Tooltip, niceTicks, tickFormatter, useChartSize } from './primitives.js';
import type { Plot, Tick } from './primitives.js';

export interface LineSeries {
  /** Short enough to sit at the right end of its own line. */
  name: string;
  /** A CSS colour, normally a var(--series-N). Marks wear it; text never does. */
  color: string;
  /** One value per entry in `x`. */
  values: number[];
}

interface Props {
  title: string;
  subtitle?: string;
  /** Shared x positions for every series, ascending. Numeric, so time scales linearly. */
  x: number[];
  series: LineSeries[];
  formatX: (v: number) => string;
  /** Used by the tooltip and the table. Axis ticks stay bare — the subtitle names the unit. */
  formatY: (v: number) => string;
  /** Header for the x column of the table view. */
  xLabel?: string;
  height?: number;
}

const MARGIN = { top: 10, bottom: 24, left: 50 };
/** Room at the right for the direct labels; dropped when the drawer is too narrow for them. */
const LABEL_GUTTER = 96;
/** Minimum vertical separation between two end labels before they get nudged apart. */
const LABEL_GAP = 13;

export function LineChart({ title, subtitle, x, series, formatX, formatY, xLabel = 'Period', height = 172 }: Props) {
  const [box, width] = useChartSize();
  const [hover, setHover] = useState<number | null>(null);

  const table = (
    <div className="chart-table-wrap scroll">
      <table className="chart-table">
        <thead>
          <tr>
            <th scope="col">{xLabel}</th>
            {series.map((s) => (
              <th key={s.name} scope="col">
                {s.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {x.map((xv, i) => (
            <tr key={xv}>
              <th scope="row">{formatX(xv)}</th>
              {series.map((s) => (
                <td key={s.name}>{formatY(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  // A legend for two or more series, never for one: with a single line the title names it and
  // a one-swatch box is just the title again, in less space.
  const legend =
    series.length >= 2 ? (
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name}>
            <i style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    ) : undefined;

  const labelled = width >= 340;
  const right = labelled ? LABEL_GUTTER : 14;
  const plot: Plot = {
    x0: MARGIN.left,
    x1: Math.max(MARGIN.left + 10, width - right),
    y0: MARGIN.top,
    y1: height - MARGIN.bottom,
  };

  const ready = width > 0 && x.length > 0 && series.length > 0;
  if (!ready) {
    return (
      <Figure title={title} subtitle={subtitle} table={table} aside={legend}>
        <div ref={box} className="chart-plot" style={{ height }} />
      </Figure>
    );
  }

  const xMin = x[0];
  const xMax = x[x.length - 1];
  const span = xMax - xMin;
  const sx = (v: number) => (span > 0 ? plot.x0 + ((v - xMin) / span) * (plot.x1 - plot.x0) : (plot.x0 + plot.x1) / 2);

  let dataMax = 0;
  for (const s of series) for (const v of s.values) if (v > dataMax) dataMax = v;
  const yVals = niceTicks(dataMax, 4);
  const yTop = yVals[yVals.length - 1] || 1;
  const sy = (v: number) => plot.y1 - (v / yTop) * (plot.y1 - plot.y0);

  const fmtTick = tickFormatter(yTop);
  const yTicks: Tick[] = yVals.map((v) => ({ pos: sy(v), label: fmtTick(v) }));

  // x ticks ride real data positions rather than interpolated dates, then thin out until no
  // two labels can collide.
  const xTicks: Tick[] = [];
  const wanted = Math.max(2, Math.min(6, Math.floor((plot.x1 - plot.x0) / 70)));
  const stride = Math.max(1, Math.ceil(x.length / wanted));
  let lastPos = -Infinity;
  for (let i = 0; i < x.length; i += stride) {
    const pos = sx(x[i]);
    if (pos - lastPos < 48) continue;
    xTicks.push({ pos, label: formatX(x[i]) });
    lastPos = pos;
  }

  const paths = series.map((s) =>
    s.values
      .map((v, i) => `${i === 0 ? 'M' : 'L'}${sx(x[i]).toFixed(1)},${sy(v).toFixed(1)}`)
      .join(' '),
  );

  // Direct labels at the right end. When lines converge the labels are nudged apart and the
  // key stroke becomes a leader line back to its own line-end, so identity never detaches.
  const ends = series
    .map((s, i) => {
      const last = s.values[s.values.length - 1] ?? 0;
      return { i, name: s.name, color: s.color, y: sy(last), ly: sy(last) };
    })
    .sort((a, b) => a.y - b.y);
  let floor = -Infinity;
  for (const e of ends) {
    e.ly = Math.max(e.y, floor + LABEL_GAP);
    floor = e.ly;
  }

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px < plot.x0 - 12 || px > plot.x1 + 12) {
      setHover(null);
      return;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < x.length; i++) {
      const d = Math.abs(sx(x[i]) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  const hx = hover === null ? 0 : sx(x[hover]);

  return (
    <Figure title={title} subtitle={subtitle} table={table} aside={legend}>
      <div ref={box} className="chart-plot" style={{ height }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}. Use the table toggle for the underlying numbers.`}
          style={{ touchAction: 'none' }}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <GridLines ticks={yTicks} plot={plot} />
          <Axis orientation="y" ticks={yTicks} plot={plot} />
          <Axis orientation="x" ticks={xTicks} plot={plot} />

          {hover !== null && (
            <line className="chart-crosshair" x1={hx} x2={hx} y1={plot.y0} y2={plot.y1} />
          )}

          {series.map((s, i) => (
            <path
              key={s.name}
              d={paths[i]}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {/* A one-bucket window has nothing to join, and a path of a single moveto draws
              nothing at all. Show the points instead of an empty frame. */}
          {x.length === 1 &&
            series.map((s) => (
              <circle
                key={s.name}
                cx={sx(x[0])}
                cy={sy(s.values[0] ?? 0)}
                r={4}
                fill={s.color}
                stroke="var(--map-surface)"
                strokeWidth={2}
              />
            ))}

          {hover !== null &&
            series.map((s) => (
              <circle
                key={s.name}
                cx={hx}
                cy={sy(s.values[hover] ?? 0)}
                r={3.5}
                fill={s.color}
                stroke="var(--map-surface)"
                strokeWidth={2}
              />
            ))}

          {labelled &&
            ends.map((e) => (
              <g key={e.name}>
                <line
                  x1={plot.x1}
                  y1={e.y}
                  x2={plot.x1 + 8}
                  y2={e.ly}
                  stroke={e.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
                <text className="chart-endlabel" x={plot.x1 + 12} y={e.ly + 3.5}>
                  {e.name}
                </text>
              </g>
            ))}
        </svg>

        {hover !== null && (
          <Tooltip x={hx} y={plot.y0 + 4} width={width}>
            <div className="tip-head">{formatX(x[hover])}</div>
            {series.map((s) => (
              <div className="tip-row" key={s.name}>
                <i style={{ background: s.color }} />
                {s.name}
                <b>{formatY(s.values[hover] ?? 0)}</b>
              </div>
            ))}
          </Tooltip>
        )}
      </div>
    </Figure>
  );
}
