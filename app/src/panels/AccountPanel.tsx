/**
 * Fetch newer activities, and erase everything.
 *
 * The delete control is deliberately two clicks and names what it destroys. Everything this
 * tool knows lives in one browser with no copy anywhere else, so there is nothing to restore
 * from -- the confirmation is the only safety net that exists.
 */

import { useEffect, useState } from 'react';
import { quota, requestPersistence } from '../lib/db.js';

function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.round(n / 1e3)} kB`;
}

export function AccountPanel({
  busy,
  connected,
  onSync,
  onConnect,
  onDisconnect,
}: {
  busy: boolean;
  connected: boolean;
  onSync: () => void;
  onConnect: () => void;
  onDisconnect: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [usage, setUsage] = useState<string | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);

  useEffect(() => {
    if (!open) return;
    void quota().then((q) => {
      if (q && q.usage > 0) setUsage(formatBytes(q.usage));
    });
    void navigator.storage?.persisted?.().then(setPersisted, () => setPersisted(null));
  }, [open]);

  if (!open) {
    return (
      <button
        className="ghost"
        onClick={() => setOpen(true)}

      >
        Your data
      </button>
    );
  }

  return (
    <div className="panel" style={{ width: 250 }}>
      <h2>
        Your data
        <button onClick={() => setOpen(false)} title="Close">
          ×
        </button>
      </h2>

      <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '0 0 12px' }}>
        Stored in this browser only{usage ? `, using about ${usage}` : ''}.
      </p>

      {/* Safari never grants persistence and clears storage after about a week without a visit.
          Saying so is the difference between a known limitation and a nasty surprise. */}
      {persisted === false && (
        <p style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, margin: '0 0 12px' }}>
          Your browser has not promised to keep this. It may clear it if disk space runs low, or
          after a long time without a visit &mdash; Safari does this after about a week. Nothing
          is lost permanently: syncing again rebuilds it from Strava.{' '}
          <button
            className="ghost"
            onClick={() => void requestPersistence().then(setPersisted)}
            style={{ padding: '2px 7px', marginTop: 5 }}
          >
            Ask again
          </button>
        </p>
      )}

      {/* A map built by the local Node pipeline is "ready" without this browser ever having
          connected to anything, so the primary offer differs. */}
      {connected && (
        <button className="ghost" onClick={onSync} disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Working…' : 'Check Strava for new activities'}
        </button>
      )}

      {/* Offered even when already "connected". Holding a credential row is not the same as
          holding a working one: revoking the app on Strava, or rotating its secret, leaves this
          browser convinced it is connected while every request fails. Without a way back to the
          authorization flow the only remaining control was the one that erases everything. */}
      <button
        className="ghost"
        onClick={onConnect}
        style={{ width: '100%', marginTop: connected ? 7 : 0 }}
      >
        {connected ? 'Reconnect to Strava' : 'Connect to Strava'}
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
