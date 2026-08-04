/**
 * Search over your own activities.
 *
 * Matches locally and instantly against the already-loaded list -- no request leaves the
 * browser, which is the same promise the rest of the tool makes.
 *
 * Place-name search used to live here too, backed by Nominatim. It is gone deliberately.
 * Nominatim's usage policy forbids using it behind a public autocomplete, and it requires an
 * identifying User-Agent that a browser will not let a page set. A personal tool could get away
 * with it; a site anyone can open cannot. Activity search was always the half people used.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivitySummary } from '@um/ledger';
import { useStore } from '../state/store.js';

export type Bounds = [number, number, number, number];

interface ActivityHit {
  kind: 'activity';
  label: string;
  sub: string;
  idx: number;
  bounds: Bounds;
}

type Hit = ActivityHit;

const MAX_ACTIVITY_HITS = 8;

export function SearchBox({ onGo }: { onGo: (bounds: Bounds, activityIdx: number | null) => void }) {
  const activities = useStore((s) => s.activities);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const activityHits = useMemo<ActivityHit[]>(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) return [];
    const out: ActivityHit[] = [];
    for (const a of activities as ActivitySummary[]) {
      if (!a.name.toLowerCase().includes(needle)) continue;
      out.push({
        kind: 'activity',
        label: a.name,
        sub: `${a.startDateLocal.slice(0, 10)} · ${a.sportType}`,
        idx: a.idx,
        bounds: a.bbox,
      });
      if (out.length >= MAX_ACTIVITY_HITS * 8) break;
    }
    // Most recent first: a name you half-remember is usually a recent one.
    out.sort((x, y) => (x.sub < y.sub ? 1 : -1));
    return out;
  }, [q, activities]);

  const shownActivities = useMemo(
    () => activityHits.slice(0, MAX_ACTIVITY_HITS),
    [activityHits],
  );
  const hits: Hit[] = shownActivities;
  const moreActivities = activityHits.length - shownActivities.length;

  useEffect(() => setCursor(0), [q]);

  const go = useCallback(
    (h: Hit) => {
      onGo(h.bounds, h.kind === 'activity' ? h.idx : null);
      setOpen(false);
      inputRef.current?.blur();
    },
    [onGo],
  );

  // Cmd+K or "/" focuses search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);

  return (
    <div
      ref={boxRef}
      className="panel"
      style={{ top: 12, left: '50%', transform: 'translateX(-50%)', width: 340, padding: 0, overflow: 'hidden' }}
    >
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false);
            inputRef.current?.blur();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setCursor((c) => Math.min(hits.length - 1, c + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setCursor((c) => Math.max(0, c - 1));
          } else if (e.key === 'Enter' && hits[cursor]) {
            go(hits[cursor]);
          }
        }}
        placeholder="Search your activities"
        aria-label="Search your activities"
        style={{
          width: '100%',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--text-primary)',
          font: 'inherit',
          padding: '10px 12px',
        }}
      />

      {open && hits.length > 0 && (
        <div style={{ borderTop: '1px solid var(--panel-border)', maxHeight: 340, overflowY: 'auto' }}>
          {hits.map((h, i) => {
            const header =
              i === 0 ? `Activities${moreActivities > 0 ? ` (${activityHits.length} matches)` : ''}` : null;
            return (
              <div key={`${i}-${h.label}`}>
                {header && (
                  <div
                    style={{
                      padding: '7px 12px 3px',
                      fontSize: 10,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {header}
                  </div>
                )}
                <button
                  onClick={() => go(h)}
                  onPointerEnter={() => setCursor(i)}
                  style={{
                    display: 'flex',
                    gap: 9,
                    alignItems: 'baseline',
                    width: '100%',
                    textAlign: 'left',
                    background: i === cursor ? 'rgba(255,255,255,0.08)' : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '6px 12px',
                    color: 'var(--text-secondary)',
                    font: 'inherit',
                  }}
                >
                  <span
                    aria-hidden
                    style={{
                      flex: '0 0 auto',
                      width: 8,
                      height: 8,
                      marginTop: 1,
                      borderRadius: 1,
                      background: 'var(--frontier)',
                    }}
                  />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--text-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h.label}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.sub}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
