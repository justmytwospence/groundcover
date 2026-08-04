/**
 * Everything that ever covered one piece of ground. Pinned by clicking the map, because a
 * tooltip that tracks the cursor cannot be clicked into.
 */

import { useEffect } from 'react';
import type { SiteInfoResult } from '../worker/protocol.js';

const SPORT_SHORT: Record<string, string> = {
  Run: 'Run',
  TrailRun: 'Trail run',
  Walk: 'Walk',
  Hike: 'Hike',
  Ride: 'Ride',
  GravelRide: 'Gravel',
  MountainBikeRide: 'MTB',
  EBikeRide: 'E-bike',
  NordicSki: 'Nordic ski',
  AlpineSki: 'Alpine ski',
  BackcountrySki: 'BC ski',
  Snowshoe: 'Snowshoe',
  Swim: 'Swim',
};

interface Props {
  info: SiteInfoResult;
  x: number;
  y: number;
  onClose: () => void;
  onPreview: (idx: number | null) => void;
}

export function SitePopup({ info, x, y, onClose, onPreview }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = info.activities ?? [];
  const dirLabel = (dir: number) => {
    if (dir === 3) return `${info.alongLabel}+${info.againstLabel}`;
    return dir & 1 ? info.alongLabel : info.againstLabel;
  };

  // Clamp into the viewport: ground near the right or bottom edge is exactly where you most
  // want to click, and a popup that runs off screen there is useless.
  const width = 290;
  const left = Math.min(Math.max(8, x + 14), window.innerWidth - width - 8);
  const top = Math.min(Math.max(8, y + 14), Math.max(8, window.innerHeight - 340));

  return (
    <div
      className="panel"
      style={{ left, top, width, padding: 0, zIndex: 60, maxHeight: 320, display: 'flex', flexDirection: 'column' }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseLeave={() => onPreview(null)}
    >
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid var(--panel-border)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>
            {info.visits === 1 ? '1 pass' : `${info.visits} passes`}
          </span>
          {info.visitsAllTime > info.visits && (
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              {info.visitsAllTime} all time
            </span>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 15,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 3 }}>
          {[
            { n: info.alongCount, l: info.alongLabel },
            { n: info.againstCount, l: info.againstLabel },
          ]
            .filter((d) => d.n > 0)
            .map((d) => `${d.n} heading ${d.l}`)
            .join('  ·  ')}
        </div>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {rows.map((a) => (
          <a
            key={a.idx}
            href={`https://www.strava.com/activities/${a.stravaId}`}
            target="_blank"
            rel="noopener noreferrer"
            onMouseEnter={() => onPreview(a.idx)}
            style={{
              display: 'block',
              padding: '6px 12px',
              textDecoration: 'none',
              color: 'var(--text-secondary)',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}
            onFocus={() => onPreview(a.idx)}
          >
            <span
              style={{
                display: 'block',
                color: 'var(--text-primary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {a.name}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {a.startDateLocal.slice(0, 10)} · {SPORT_SHORT[a.sportType] ?? a.sportType} ·{' '}
              {dirLabel(a.dir)}
            </span>
          </a>
        ))}
        {rows.length === 0 && (
          <div style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>
            No activities in the current filters.
          </div>
        )}
      </div>

      <div
        style={{
          padding: '6px 12px',
          borderTop: '1px solid var(--panel-border)',
          color: 'var(--text-muted)',
          fontSize: 10,
        }}
      >
        Hover a row to trace it. Click to open on Strava.
      </div>
    </div>
  );
}
