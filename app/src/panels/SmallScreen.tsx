/**
 * The map's control panels are fixed-width and positioned against the viewport corners, so
 * below roughly 700px they overlap each other and the map. That reads as "this site is broken"
 * rather than "this site expects a bigger window".
 *
 * Deliberately dismissible. Someone who wants to look at their own map on a phone, overlapping
 * panels and all, is entitled to -- being told what to expect is the point, not being locked
 * out. The choice is remembered so it does not nag on every visit.
 */

import { useEffect, useState } from 'react';

const MIN_WIDTH = 700;
const KEY = 'um.smallscreen.dismissed';

export function SmallScreen() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < MIN_WIDTH);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(KEY) === '1');

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MIN_WIDTH - 1}px)`);
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  if (!narrow || dismissed) return null;

  return (
    <div className="smallscreen">
      <div className="connect-card" style={{ maxWidth: 420 }}>
        <h1 className="connect-title" style={{ fontSize: 22 }}>
          This wants a bigger window
        </h1>
        <p className="connect-lede" style={{ fontSize: 14 }}>
          The map has several control panels that assume a desktop-sized screen. On a window this
          narrow they overlap each other and cover the map.
        </p>
        <p className="connect-lede" style={{ fontSize: 14 }}>
          Everything still works, and your data is safe either way &mdash; it just will not look
          right.
        </p>
        <button
          className="ghost"
          onClick={() => {
            localStorage.setItem(KEY, '1');
            setDismissed(true);
          }}
        >
          Show it anyway
        </button>
      </div>
    </div>
  );
}
