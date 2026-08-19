/**
 * The rail on a desktop; a drag-up sheet on a phone. Same DOM either way.
 *
 * It exists so the phone layout keeps the docking rule the desktop one establishes: the sheet
 * takes a grid row rather than floating, so whatever height it is at, the map's cell is exactly
 * what the viewer can see, and a fit that pads the map's cell is honest. That is why the height
 * is published as a CSS variable on the shell instead of the sheet positioning itself.
 *
 * Stops rather than free positioning, because a sheet left at an arbitrary height on a phone is
 * a sheet you have to fight on every glance. Which stop you are at is a property of the screen
 * in front of you, not of the view, so it stays out of the URL.
 */

import { useCallback, useRef, type ReactNode } from 'react';

export type SheetStop = 'peek' | 'half' | 'full';

/**
 * Peek is the grab handle alone: the transport row above it stays visible at every stop.
 *
 * Full stops at 55% rather than filling the screen. This is a map: a sheet that can cover it
 * completely turns the thing you came for into something you have to dismiss the UI to see,
 * and the grid would happily collapse the map's row to nothing to make room.
 */
const STOP_FRACTION: Record<SheetStop, number> = { peek: 0, half: 0.32, full: 0.55 };
const HANDLE_H = 34;

/** Never let a drag leave less than this much map. Matches the grid's minimum row. */
const MIN_MAP_H = 140;

/** Height in pixels for a stop, given the space the shell has. */
export function stopHeight(stop: SheetStop, viewportH: number): number {
  const h = HANDLE_H + STOP_FRACTION[stop] * viewportH;
  return Math.round(Math.min(h, Math.max(HANDLE_H, viewportH - MIN_MAP_H)));
}

/** The stop whose height is nearest, so a release always lands somewhere deliberate. */
function nearestStop(h: number, viewportH: number): SheetStop {
  const stops: SheetStop[] = ['peek', 'half', 'full'];
  return stops.reduce((best, s) =>
    Math.abs(stopHeight(s, viewportH) - h) < Math.abs(stopHeight(best, viewportH) - h) ? s : best,
  );
}

interface Props {
  children: ReactNode;
  /** Live height while dragging, so the shell can size its row; null when at rest. */
  onDragHeight: (px: number | null) => void;
  onStop: (stop: SheetStop) => void;
  stop: SheetStop;
}

export function Sheet({ children, onDragHeight, onStop, stop }: Props) {
  const drag = useRef<{ id: number; startY: number; startH: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      // Suppresses the text selection a mouse drag down the sheet would otherwise paint.
      e.preventDefault();
      // Captured, so a finger that leaves the 34px handle mid-drag keeps driving it and a
      // cancelled gesture still reports back. Without capture the sheet sticks to the finger
      // only while it is exactly on the handle, which on a phone is most of the time not.
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { id: e.pointerId, startY: e.clientY, startH: stopHeight(stop, window.innerHeight) };
    },
    [stop],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      // Dragging up grows the sheet, so the delta is inverted.
      const h = d.startH + (d.startY - e.clientY);
      onDragHeight(Math.max(HANDLE_H, Math.min(h, window.innerHeight * STOP_FRACTION.full + HANDLE_H)));
    },
    [onDragHeight],
  );

  const end = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      drag.current = null;
      const h = Math.max(HANDLE_H, d.startH + (d.startY - e.clientY));
      onDragHeight(null);
      onStop(nearestStop(h, window.innerHeight));
    },
    [onDragHeight, onStop],
  );

  return (
    <div className="rail">
      <button
        className="sheet-handle"
        aria-label={stop === 'peek' ? 'Show controls' : 'Hide controls'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        // A gesture the browser takes over fires this and never `pointerup`. Handling only
        // `pointerup` leaves the drag latched, and every later touch keeps moving the sheet.
        onPointerCancel={end}
        // Tapping the handle is the discoverable way through the stops; dragging is the
        // shortcut, not the requirement.
        onClick={() => {
          if (!drag.current) onStop(stop === 'peek' ? 'half' : stop === 'half' ? 'full' : 'peek');
        }}
      />
      {children}
    </div>
  );
}
