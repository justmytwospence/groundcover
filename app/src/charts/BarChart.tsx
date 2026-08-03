/**
 * Single-series bar chart. See SPEC.md section 6.5 chart 2.
 *
 * One series only, so no legend: the title names what is plotted. Baseline anchored at zero —
 * a truncated bar baseline lies about ratios, and bars are read as ratios.
 */

import { useState } from 'react';
import { Axis, Figure, GridLines, Tooltip, niceTicks, tickFormatter, useChartSize } from './primitives.js';
import type { Plot, Tick } from './primitives.js';

export interface BarDatum {
  /** Stable React key. */
  key: string;
  label: string;
  /** Non-negative; this chart anchors at zero and does not draw downward. */
  value: number;
}

interface Props {
  title: string;
  subtitle?: string;
  data: BarDatum[];
  /** A CSS colour, normally var(--series-1). */
  color: string;
  /** Used by the tooltip and the table. Axis ticks stay bare — the subtitle names the unit. */
  formatY: (v: number) => string;
  /** Headers for the table view. */
  xLabel?: string;
  valueLabel?: string;
  height?: number;
}

const MARGIN = { top: 10, right: 14, bottom: 24, left: 50 };
/** The surface gap that separates touching bars. Never a stroke: that adds ink that isn't data. */
const GAP = 2;
const RADIUS = 4;
/** Bars are capped rather than filling their band, so a short series keeps its air. */
const MAX_BAR = 28;
/** Enough for a one-row tooltip; used only to keep it from clearing the top of the plot. */
const TIP_HEIGHT = 48;

/** A bar with a rounded top and square feet on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.max(0, Math.min(RADIUS, w / 2, h));
  return `M${x},${y + h}L${x},${y + r}Q${x},${y} ${x + r},${y}L${x + w - r},${y}Q${x + w},${y} ${x + w},${y + r}L${x + w},${y + h}Z`;
}

export function BarChart({
  title,
  subtitle,
  data,
  color,
  formatY,
  xLabel = 'Period',
  valueLabel = 'Value',
  height = 150,
}: Props) {
  const [box, width] = useChartSize();
  const [hover, setHover] = useState<number | null>(null);

  const table = (
    <div className="chart-table-wrap scroll">
      <table className="chart-table">
        <thead>
          <tr>
            <th scope="col">{xLabel}</th>
            <th scope="col">{valueLabel}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.label}</th>
              <td>{formatY(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const plot: Plot = {
    x0: MARGIN.left,
    x1: Math.max(MARGIN.left + 10, width - MARGIN.right),
    y0: MARGIN.top,
    y1: height - MARGIN.bottom,
  };

  const ready = width > 0 && data.length > 0;
  if (!ready) {
    return (
      <Figure title={title} subtitle={subtitle} table={table}>
        <div ref={box} className="chart-plot" style={{ height }} />
      </Figure>
    );
  }

  let dataMax = 0;
  for (const d of data) if (d.value > dataMax) dataMax = d.value;
  const yVals = niceTicks(dataMax, 4);
  const yTop = yVals[yVals.length - 1] || 1;
  const sy = (v: number) => plot.y1 - (v / yTop) * (plot.y1 - plot.y0);
  const fmtTick = tickFormatter(yTop);
  const yTicks: Tick[] = yVals.map((v) => ({ pos: sy(v), label: fmtTick(v) }));

  const band = (plot.x1 - plot.x0) / data.length;
  const barW = Math.max(1, Math.min(band - GAP, MAX_BAR));
  const bandX = (i: number) => plot.x0 + i * band;
  const barX = (i: number) => bandX(i) + (band - barW) / 2;

  // Thin the category labels until they cannot collide, rather than rotating or clipping them.
  const stride = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor((plot.x1 - plot.x0) / 62))));
  const xTicks: Tick[] = [];
  for (let i = 0; i < data.length; i += stride) {
    xTicks.push({ pos: bandX(i) + band / 2, label: data[i].label });
  }

  const hovered = hover === null ? null : data[hover];

  return (
    <Figure title={title} subtitle={subtitle} table={table}>
      <div ref={box} className="chart-plot" style={{ height }}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}. Use the table toggle for the underlying numbers.`}
          style={{ touchAction: 'none' }}
          onPointerLeave={() => setHover(null)}
        >
          <GridLines ticks={yTicks} plot={plot} />
          <Axis orientation="y" ticks={yTicks} plot={plot} />
          <Axis orientation="x" ticks={xTicks} plot={plot} />

          {data.map((d, i) => {
            const h = Math.max(0, plot.y1 - sy(Math.max(0, d.value)));
            return (
              <path
                key={d.key}
                d={barPath(barX(i), plot.y1 - h, barW, h)}
                fill={color}
                opacity={hover === null || hover === i ? 1 : 0.55}
              />
            );
          })}

          {/* Hit targets span the whole band and the full plot height: a 1px bar is unhittable. */}
          {data.map((d, i) => (
            <rect
              key={d.key}
              x={bandX(i)}
              y={plot.y0}
              width={band}
              height={plot.y1 - plot.y0}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
              onPointerMove={() => setHover(i)}
            />
          ))}
        </svg>

        {hover !== null && hovered !== null && (
          <Tooltip
            x={barX(hover) + barW / 2}
            // Above the bar's cap, floored so a full-height bar does not push it off the top.
            // A short bar sits near the baseline, where a downward tooltip would spill out of
            // the figure and over whatever follows it.
            y={Math.max(TIP_HEIGHT, sy(Math.max(0, hovered.value)) - 6)}
            width={width}
            above
          >
            <div className="tip-head">{hovered.label}</div>
            <div className="tip-row">
              <i style={{ background: color }} />
              {valueLabel}
              <b>{formatY(hovered.value)}</b>
            </div>
          </Tooltip>
        )}
      </div>
    </Figure>
  );
}
