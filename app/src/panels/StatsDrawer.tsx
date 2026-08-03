/**
 * The stats drawer: four views of the current selection. See SPEC.md section 6.5.
 *
 * Everything here is derived from `extras`, which the worker computes only while the drawer is
 * open, so playback never pays for charts.
 */

import { useMemo } from 'react';
import type { ActivitySummary } from '@um/ledger';
import type { QueryExtras } from '../worker/protocol.js';
import { M_PER_UNIT, fmtDist, useStore } from '../state/store.js';
import { LineChart } from '../charts/LineChart.js';
import { BarChart } from '../charts/BarChart.js';
import { Figure } from '../charts/primitives.js';

interface Props {
  extras: QueryExtras | null;
  onSelectActivity: (idx: number) => void;
  onClose: () => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Categorical slots in fixed order, capped at three. A fourth group folds to muted, never a
 *  generated hue. */
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const OTHER = 'var(--text-muted)';

const YEAR_SECONDS = 330 * 86400;

export function StatsDrawer({ extras, onSelectActivity, onClose }: Props) {
  const activities = useStore((s) => s.activities);
  const manifest = useStore((s) => s.manifest);
  const units = useStore((s) => s.units);

  const perUnit = M_PER_UNIT[units];
  /** Distances always carry their unit; charts hold values in display units and format back. */
  const fmt = (m: number) => `${fmtDist(m, units)} ${units}`;
  const fmtValue = (v: number) => fmt(v * perUnit);

  const buckets = useMemo(() => extras?.byBucket ?? [], [extras]);

  // The worker buckets monthly under a three-year window and yearly above it. Rather than
  // re-deriving that rule from the window, read it off the spacing the worker actually used.
  const yearly = useMemo(() => {
    if (buckets.length >= 2) return buckets[1].bucketStart - buckets[0].bucketStart >= YEAR_SECONDS;
    return buckets.length === 1 && new Date(buckets[0].bucketStart * 1000).getUTCMonth() === 0;
  }, [buckets]);

  const formatBucket = useMemo(() => {
    return (ts: number) => {
      const d = new Date(ts * 1000);
      const y = d.getUTCFullYear();
      return yearly ? String(y) : `${MONTHS[d.getUTCMonth()]} ${y}`;
    };
  }, [yearly]);

  // Chart 1 runs a cumulative sum over the buckets; both lines share one axis and one unit.
  const cumulative = useMemo(() => {
    const x: number[] = [];
    const newGround: number[] = [];
    const totalLogged: number[] = [];
    let n = 0;
    let t = 0;
    for (const b of buckets) {
      n += b.newM;
      t += b.totalM;
      x.push(b.bucketStart);
      newGround.push(n / perUnit);
      totalLogged.push(t / perUnit);
    }
    return { x, newGround, totalLogged };
  }, [buckets, perUnit]);

  const bars = useMemo(
    () =>
      buckets.map((b) => ({
        key: String(b.bucketStart),
        label: formatBucket(b.bucketStart),
        value: b.newM / perUnit,
      })),
    [buckets, formatBucket, perUnit],
  );

  const byIdx = useMemo(() => {
    const m = new Map<number, ActivitySummary>();
    for (const a of activities) m.set(a.idx, a);
    return m;
  }, [activities]);

  const discoveries = useMemo(() => {
    const rows = (extras?.perActivityNewM ?? []).slice(0, 20);
    const max = rows.reduce((acc, r) => Math.max(acc, r.newM), 0) || 1;
    return rows.flatMap((r) => {
      const a = byIdx.get(r.idx);
      if (!a) return [];
      return [{ a, newM: r.newM, share: r.newM / max }];
    });
  }, [extras, byIdx]);

  const sports = useMemo(() => {
    const rows = [...(extras?.byGroup ?? [])].sort((x, y) => y.totalM - x.totalM);
    // Colour follows the ENTITY, not its rank. Keying off the sport-group index means a
    // filter that drops the largest group cannot repaint the survivors -- "foot" is the same
    // colour whether or not "ride" is on screen. Groups past the third fold into one neutral.
    return rows.map((r) => ({
      ...r,
      name: manifest?.sportGroups[r.group] ?? `Group ${r.group}`,
      color: r.group < SERIES.length ? SERIES[r.group] : OTHER,
      // Share of logged distance that retraced ground already covered. Clamped at zero: the
      // two distances come from different sources, so a hair of drift must not read as a
      // negative ratio.
      repeat: r.totalM > 0 ? Math.max(0, 1 - r.distinctM / r.totalM) : null,
    }));
  }, [extras, manifest]);

  const unitWord = units === 'mi' ? 'miles' : 'kilometres';

  return (
    <aside className="panel stats-drawer" aria-label="Stats and charts">
      <h2>
        Stats and charts
        <button onClick={onClose} aria-label="Close stats and charts">
          ×
        </button>
      </h2>

      {extras === null ? (
        <p className="chart-empty">Loading charts...</p>
      ) : (
        <div className="stats-drawer-body">
          <LineChart
            title="Cumulative coverage"
            subtitle={`Running totals across the selected window, in ${unitWord}.`}
            x={cumulative.x}
            series={[
              { name: 'New ground', color: 'var(--series-1)', values: cumulative.newGround },
              { name: 'Total logged', color: 'var(--series-2)', values: cumulative.totalLogged },
            ]}
            formatX={formatBucket}
            formatY={fmtValue}
            xLabel={yearly ? 'Year' : 'Month'}
          />

          <BarChart
            title="New ground per period"
            subtitle={`Ground covered for the first time, by ${yearly ? 'year' : 'month'}, in ${unitWord}.`}
            data={bars}
            color="var(--series-1)"
            formatY={fmtValue}
            xLabel={yearly ? 'Year' : 'Month'}
            valueLabel="New ground"
          />

          <Figure
            title="Biggest discoveries"
            subtitle="The 20 activities that opened the most new ground in this selection. Select one to draw it on the map."
          >
            {discoveries.length === 0 ? (
              <p className="chart-empty">No activities in this selection</p>
            ) : (
              <div className="chart-table-wrap">
                {/* Fixed layout: six columns will not fit the drawer at their natural widths,
                    and the numbers must never be the thing that gets cut off. */}
                <table className="chart-table fixed">
                  <colgroup>
                    <col style={{ width: '17%' }} />
                    <col style={{ width: '27%' }} />
                    <col style={{ width: '16%' }} />
                    <col style={{ width: '17%' }} />
                    <col style={{ width: '13%' }} />
                    <col style={{ width: '10%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Activity</th>
                      <th scope="col">Sport</th>
                      <th scope="col">New ground</th>
                      <th scope="col">Distance</th>
                      <th scope="col">% new</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discoveries.map(({ a, newM, share }) => (
                      <tr
                        key={a.idx}
                        className="row-click"
                        tabIndex={0}
                        onClick={() => onSelectActivity(a.idx)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelectActivity(a.idx);
                          }
                        }}
                      >
                        <td>{a.startDateLocal.slice(0, 10)}</td>
                        <th scope="row" className="name" title={a.name}>
                          {a.name}
                        </th>
                        <td>{a.sportType}</td>
                        <td className="cellbar">
                          <div className="cellbar-fill" style={{ width: `${share * 100}%` }} />
                          <span>{fmt(newM)}</span>
                        </td>
                        <td>{fmt(a.distanceM)}</td>
                        {/* Capped at 100: Strava's recorded distance and our resampled
                            along-track length differ by a percent or two, and "112% new" reads
                            as a bug rather than as the rounding it is. */}
                        <td>
                          {a.distanceM > 0
                            ? `${Math.min(100, Math.round((newM / a.distanceM) * 100))}%`
                            : '--'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Figure>

          <Figure title="By sport">
            <p className="chart-note">
              Ground covered by more than one sport appears in every row that covers it, so the rows do not
              sum to the total.
            </p>
            {sports.length === 0 ? (
              <p className="chart-empty">No activities in this selection</p>
            ) : (
              <div className="chart-table-wrap">
                <table className="chart-table">
                  <thead>
                    <tr>
                      <th scope="col">Sport</th>
                      <th scope="col">Distinct ground</th>
                      <th scope="col">New ground</th>
                      <th scope="col">Total logged</th>
                      <th scope="col">Repeat</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sports.map((s) => (
                      <tr key={s.group}>
                        <th scope="row" className="sport">
                          <i className="sport-key" style={{ background: s.color }} />
                          {s.name}
                        </th>
                        <td>{fmt(s.distinctM)}</td>
                        <td>{fmt(s.newM)}</td>
                        <td>{fmt(s.totalM)}</td>
                        <td>{s.repeat === null ? '--' : `${Math.round(s.repeat * 100)}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Figure>
        </div>
      )}
    </aside>
  );
}
