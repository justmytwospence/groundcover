/**
 * Fetch newer activities, and erase everything.
 *
 * The delete control is deliberately two clicks and names what it destroys. Everything this
 * tool knows lives in one browser with no copy anywhere else, so there is nothing to restore
 * from -- the confirmation is the only safety net that exists.
 */

import { useEffect, useState } from 'react';
import { quota } from '../lib/db.js';

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

export function AccountPanel({
  busy,
  onSync,
  onDisconnect,
}: {
  busy: boolean;
  onSync: () => void;
  onDisconnect: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void quota().then((q) => {
      if (q && q.usage > 0) setUsage(formatBytes(q.usage));
    });
  }, [open]);

  if (!open) {
    return (
      <button
        className="ghost"
        onClick={() => setOpen(true)}
        style={{ position: 'absolute', left: 12, bottom: 128, zIndex: 10 }}
      >
        Your data
      </button>
    );
  }

  return (
    <div className="panel" style={{ left: 12, bottom: 128, width: 250 }}>
      <h2>
        Your data
        <button onClick={() => setOpen(false)} title="Close">
          ×
        </button>
      </h2>

      <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '0 0 12px' }}>
        Stored in this browser only{usage ? `, using about ${usage}` : ''}.
      </p>

      <button className="ghost" onClick={onSync} disabled={busy} style={{ width: '100%' }}>
        {busy ? 'Working…' : 'Check Strava for new activities'}
      </button>

      <div style={{ marginTop: 10 }}>
        {confirming ? (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5, margin: '0 0 8px' }}>
              This erases every downloaded activity, your computed map, and your Strava
              credentials from this browser. There is no copy anywhere else.
            </p>
            <div style={{ display: 'flex', gap: 7 }}>
              <button
                className="ghost"
                onClick={() => void onDisconnect()}
                style={{ borderColor: 'rgba(220,70,50,0.5)', color: '#ffb3a3' }}
              >
                Erase everything
              </button>
              <button className="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <button className="ghost" onClick={() => setConfirming(true)} style={{ width: '100%' }}>
            Disconnect and erase
          </button>
        )}
      </div>
    </div>
  );
}
