/**
 * What was left out, and why.
 *
 * The exclusion rules drop trainer entries, manual entries, virtual rides, activities with no
 * GPS, and recordings that never actually moved. On the repo owner's own history that is a
 * handful and obvious. On a stranger's it can be hundreds, and the result would be a map that
 * looks entirely plausible sitting next to a headline number that is far too low -- with
 * nothing anywhere to suggest anything was missing.
 *
 * So the arithmetic is shown rather than asserted: included plus excluded equals what was read.
 */

import { useState } from 'react';

export interface BuildReport {
  seen: number;
  included: number;
  excluded: Record<string, number>;
}

/** Written for someone who has never read the algorithm docs and never should have to. */
const WHY: Record<string, string> = {
  trainer: 'recorded on a trainer, so there is no ground to cover',
  manual: 'entered by hand, with no GPS track',
  virtual: 'a virtual ride — real effort, but not real ground',
  'no-gps': 'no GPS was recorded',
  'stream-mismatch': 'the GPS and time data did not line up, so it could not be trusted',
  'treadmill-shaped': 'the GPS never moved while distance was recorded — a treadmill or a stationary session',
  'too-short': 'too little movement left to measure once duplicate points were removed',
};

export function ImportReport({ report, onClose }: { report: BuildReport; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const total = Object.values(report.excluded).reduce((a, b) => a + b, 0);

  if (total === 0) return null;

  const rows = Object.entries(report.excluded).sort((a, b) => b[1] - a[1]);
  // If this ever fails to add up, the honest thing is to say so rather than quietly show a
  // number that does not reconcile.
  const balances = report.included + total === report.seen;

  return (
    <div className="panel import-report">
      <h2>
        Not everything counted
        <button onClick={onClose} title="Dismiss">
          ×
        </button>
      </h2>

      <div className="import-sum">
        <strong>{report.included.toLocaleString()}</strong> of {report.seen.toLocaleString()}{' '}
        activities are on your map. <strong>{total.toLocaleString()}</strong>{' '}
        {total === 1 ? 'was' : 'were'} left out, because there was no ground in{' '}
        {total === 1 ? 'it' : 'them'} to measure.
      </div>

      {!balances && (
        <div className="import-warn">
          These numbers do not add up, which is a bug. Please treat the total as unreliable.
        </div>
      )}

      {open && (
        <ul className="import-reasons">
          {rows.map(([reason, n]) => (
            <li key={reason}>
              <span className="import-count">{n.toLocaleString()}</span>
              <span>{WHY[reason] ?? reason}</span>
            </li>
          ))}
        </ul>
      )}

      <button className="ghost" onClick={() => setOpen((v) => !v)} style={{ marginTop: 10 }}>
        {open ? 'Hide the breakdown' : 'Why?'}
      </button>
    </div>
  );
}
