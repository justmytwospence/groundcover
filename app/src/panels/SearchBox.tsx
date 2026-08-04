/**
 * Combined search over your own activities and over place names.
 *
 * Activities match locally and instantly against the already-loaded list; places go to
 * Nominatim, debounced. Activity results come first because in this tool "where was that
 * ride" is asked far more often than "where is Reykjavik".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ActivitySummary } from '@um/ledger';
import { useStore } from '../state/store.js';

export type Bounds = [number, number, number, number];

interface PlaceHit {
  kind: 'place';
  label: string;
  bounds: Bounds;
}

interface ActivityHit {
  kind: 'activity';
  label: string;
  sub: string;
  idx: number;
  bounds: Bounds;
}

type Hit = PlaceHit | ActivityHit;

interface NominatimRow {
  display_name: string;
  boundingbox: [string, string, string, string];
}

/** Cap activities harder when places are also on offer, so the Places group is never pushed
 *  below the fold. A city that shares a name with a dozen of your runs is the common case. */
const MAX_ACTIVITY_HITS = 6;
const MAX_ACTIVITY_HITS_WITH_PLACES = 4;
const MAX_PLACE_HITS = 4;

export function SearchBox({ onGo }: { onGo: (bounds: Bounds, activityIdx: number | null) => void }) {
  const activities = useStore((s) => s.activities);
  const [q, setQ] = useState('');
  const [places, setPlaces] = useState<PlaceHit[]>([]);
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

  // Nominatim asks for no more than one request a second and no bulk querying; a debounce
  // plus a 3-character floor keeps a personal tool well inside that.
  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 3) {
      setPlaces([]);
      return;
    }
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=${MAX_PLACE_HITS}&q=${encodeURIComponent(needle)}`,
          { signal: ctl.signal, headers: { Accept: 'application/json' } },
        );
        if (!res.ok) return;
        const rows = (await res.json()) as NominatimRow[];
        setPlaces(
          rows.map((r) => {
            const [s, n, w, e] = r.boundingbox.map(Number);
            return { kind: 'place' as const, label: r.display_name, bounds: [w, s, e, n] as Bounds };
          }),
        );
      } catch {
        // A failed or aborted lookup just means no place results; activities still work.
      }
    }, 450);
    return () => {
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [q]);

  const shownActivities = useMemo(
    () => activityHits.slice(0, places.length ? MAX_ACTIVITY_HITS_WITH_PLACES : MAX_ACTIVITY_HITS),
    [activityHits, places.length],
  );
  const hits: Hit[] = useMemo(
    () => [...shownActivities, ...places],
    [shownActivities, places],
  );
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
        placeholder="Search activities or places"
        aria-label="Search activities or places"
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
            // Group headers make it obvious that both kinds of result are on offer. Without
            // them a city buried under six same-named runs reads as "no place search".
            const header =
              i === 0 && h.kind === 'activity'
                ? `Activities${moreActivities > 0 ? ` (${activityHits.length} matches)` : ''}`
                : h.kind === 'place' && (i === 0 || hits[i - 1].kind === 'activity')
                  ? 'Places'
                  : null;
            return (
              <div key={`${h.kind}-${i}-${h.label}`}>
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
                      borderRadius: h.kind === 'place' ? '50% 50% 50% 0' : 1,
                      transform: h.kind === 'place' ? 'rotate(-45deg)' : 'none',
                      background: h.kind === 'place' ? 'var(--text-muted)' : 'var(--frontier)',
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
                    {h.kind === 'activity' && (
                      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{h.sub}</span>
                    )}
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
