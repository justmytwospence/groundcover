/**
 * Hand someone else exactly what you are looking at.
 *
 * The link always carries the time frame, because that is the thing that is hard to reproduce
 * by hand: the exact window a scrub landed on, down to the second. The map view is opt-in.
 * Without it the recipient's map fits the ground that window covers, framed for their screen
 * rather than yours -- which is what you want almost every time, and is why the address bar no
 * longer pins a camera into every URL you copy out of it (SPEC.md section 6.8).
 */

import { useEffect, useRef, useState } from 'react';
import { buildShareUrl, useStore } from '../state/store.js';

const fmtDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export function SharePanel({
  getViewBounds,
  onClose,
}: {
  getViewBounds: () => [number, number, number, number] | null;
  onClose: () => void;
}) {
  const [includeView, setIncludeView] = useState(false);
  const [copied, setCopied] = useState(false);
  const t0 = useStore((s) => s.t0);
  const t1 = useStore((s) => s.t1);
  const inputRef = useRef<HTMLInputElement>(null);

  // Rebuilt on every render rather than held in state: the window moves under the panel while
  // it is open, and a stale link is worse than no link.
  const url = buildShareUrl(includeView, getViewBounds());

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard access is refused without a user gesture in some browsers, and always over
      // plain http. Select the text so the copy is one keystroke away rather than impossible.
      inputRef.current?.select();
    }
  };

  return (
    <div className="panel" style={{ width: 290 }}>
      <h2>
        Share this view
        <button onClick={onClose} aria-label="Close">
          ×
        </button>
      </h2>

      <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 8 }}>
        {fmtDay(t0)} — {fmtDay(t1)}
      </div>

      <input
        ref={inputRef}
        className="share-url"
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
      />

      <label className="check" style={{ fontSize: 12, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={includeView}
          onChange={(e) => setIncludeView(e.currentTarget.checked)}
        />
        Pin the current map view
      </label>
      <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45, marginTop: 2 }}>
        {includeView
          ? 'Opens at exactly this extent, whatever screen it is opened on.'
          : 'Opens framed on the ground this time frame covers.'}
      </div>

      <button className="ghost" onClick={copy} style={{ marginTop: 10, width: '100%' }}>
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}
