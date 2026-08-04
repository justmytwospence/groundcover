/**
 * Sync progress, shown over the map rather than in front of it.
 *
 * A first backfill of a long history can run for days across several sittings, so this must be
 * something a person can leave running and ignore. It never blocks the map: whatever has already
 * arrived is already drawn and already usable.
 */

import { useEffect, useState } from 'react';
import { formatDuration, type SyncProgress } from './sync.js';

function pct(p: SyncProgress): number {
  const total = p.stored + p.remaining;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((p.stored / total) * 100));
}

function Countdown({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, until - now);
  return <>{formatDuration(left)}</>;
}

export function SyncRibbon({
  progress,
  onStop,
  onDismiss,
}: {
  progress: SyncProgress;
  onStop: () => void;
  onDismiss: () => void;
}) {
  const [showWarnings, setShowWarnings] = useState(false);
  const p = progress;
  const finished =
    p.phase === 'done' ||
    p.phase === 'stopped' ||
    p.phase === 'out-of-budget' ||
    p.phase === 'out-of-space' ||
    p.phase === 'error';

  let line: React.ReactNode;
  switch (p.phase) {
    case 'starting':
      line = 'Connecting to Strava…';
      break;
    case 'summaries':
      line = `Asking Strava what you have done — ${p.known.toLocaleString()} activities so far`;
      break;
    case 'streams':
      line = p.current ?? 'Downloading activities';
      break;
    case 'waiting':
      line = (
        <>
          {p.message ?? 'Waiting'} — resuming in{' '}
          {p.waitUntil ? <Countdown until={p.waitUntil} /> : 'a moment'}
        </>
      );
      break;
    default:
      line = p.message ?? '';
  }

  return (
    <div className={`sync-ribbon${finished ? ' sync-ribbon-done' : ''}`}>
      <div className="sync-ribbon-main">
        <div className="sync-ribbon-line1">{line}</div>
        <div className="sync-ribbon-line2">
          {p.stored.toLocaleString()} of {(p.stored + p.remaining).toLocaleString()} activities
          {p.remaining > 0 && p.phase === 'streams' && (
            <> · about {formatDuration(p.etaMs)} left</>
          )}
          {p.rateLimit && (
            <>
              {' '}
              · {p.rateLimit.dailyUsage}/{p.rateLimit.dailyLimit} of today&rsquo;s Strava requests
            </>
          )}
        </div>
        {!finished && (
          <div className="sync-bar">
            <div className="sync-bar-fill" style={{ width: `${pct(p)}%` }} />
          </div>
        )}
      </div>

      <div className="sync-ribbon-actions">
        {p.warnings.length > 0 && (
          <button className="ghost" onClick={() => setShowWarnings((v) => !v)}>
            {p.warnings.length} skipped
          </button>
        )}
        {finished ? (
          <button className="ghost" onClick={onDismiss}>
            Dismiss
          </button>
        ) : (
          <button className="ghost" onClick={onStop}>
            Stop
          </button>
        )}
      </div>

      {showWarnings && (
        <div className="sync-warnings">
          <p>
            These were left out. Almost always this means the activity had no GPS &mdash; a
            treadmill run, a manual entry, or an indoor ride.
          </p>
          <ul>
            {p.warnings.slice(0, 200).map((w) => (
              <li key={w.activityId}>
                <span>{w.name}</span> <em>{w.reason}</em>
              </li>
            ))}
          </ul>
          {p.warnings.length > 200 && <p>…and {p.warnings.length - 200} more.</p>}
        </div>
      )}
    </div>
  );
}
