import { useState } from 'react';
import { fmtDist, useStore } from '../state/store.js';
import { HowItWorks } from './HowItWorks.js';

export function StatsCard() {
  const { stats, units, viewportFilter, statsOpen, drawerOpen } = useStore();
  const set = useStore((s) => s.set);
  const [howOpen, setHowOpen] = useState(false);

  const empty = stats.activityCount === 0;
  const repeat = stats.totalM && stats.totalM > 0 ? 1 - stats.distinctM / stats.totalM : null;

  return (
    <>
      <div className="panel" style={{ top: 12, right: 12, width: 268 }}>
        <h2>
          {viewportFilter ? 'Stats · map view' : 'Stats'}
          <button onClick={() => set({ statsOpen: !statsOpen })} aria-label="Toggle stats">
            {statsOpen ? '−' : '+'}
          </button>
        </h2>

        {statsOpen && (
          <>
            {empty ? (
              <div style={{ color: 'var(--text-muted)', padding: '6px 0 10px' }}>
                No activities in this selection
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                  <div>
                    <div className="stat-value">{fmtDist(stats.distinctM, units)}</div>
                    <div className="stat-label">
                      distinct ground ({units})
                    </div>
                  </div>
                  <div>
                    <div className="stat-value" style={{ color: 'var(--frontier)' }}>
                      {fmtDist(stats.newM, units)}
                    </div>
                    <div className="stat-label">new ground ({units})</div>
                  </div>
                </div>

                <hr className="rule" />

                <div className="stat-sub">
                  <span>Total logged</span>
                  <span>{stats.totalM === null ? '—' : `${fmtDist(stats.totalM, units)} ${units}`}</span>
                </div>
                <div className="stat-sub">
                  <span>Repeat ratio</span>
                  <span>{repeat === null ? '—' : `${Math.round(repeat * 100)}%`}</span>
                </div>
                <div className="stat-sub">
                  <span>Activities</span>
                  <span>{stats.activityCount.toLocaleString()}</span>
                </div>
              </>
            )}

            <hr className="rule" />

            <label className="check">
              <input
                type="checkbox"
                checked={viewportFilter}
                onChange={(e) => set({ viewportFilter: e.target.checked })}
              />
              <span>Limit stats to map view</span>
            </label>
            {viewportFilter && (
              <div style={{ color: 'var(--text-muted)', fontSize: 11, paddingLeft: 22 }}>
                Total logged is hidden: an activity&apos;s distance has no position to clip.
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center' }}>
              <button className="ghost" onClick={() => set({ drawerOpen: !drawerOpen })}>
                {drawerOpen ? 'Hide charts' : 'Stats and charts'}
              </button>
              <button
                className="chip"
                onClick={() => set({ units: units === 'mi' ? 'km' : 'mi' })}
                aria-label="Toggle units"
              >
                {units}
              </button>
            </div>

            <button
              className="ghost"
              style={{ marginTop: 6, width: '100%', border: 'none', background: 'none', color: 'var(--text-muted)', textAlign: 'left', padding: '2px 0' }}
              onClick={() => setHowOpen(true)}
            >
              How this is calculated
            </button>
          </>
        )}
      </div>

      {howOpen && <HowItWorks onClose={() => setHowOpen(false)} />}
    </>
  );
}
