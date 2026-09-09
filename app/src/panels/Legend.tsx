import { useStore } from '../state/store.js';
import { PALETTES } from '../lib/theme.js';

/**
 * The key to the map: continuous ramps rather than named bands.
 *
 * Rendered inside the filter panel rather than as its own floating box. It reads as part of the
 * map-mode control it describes -- the ramps change when the mode does -- and one panel fewer is
 * one less thing occupying a corner of somebody's map.
 *
 * The bands were arbitrary. "5-9" says nothing about anybody's history, and a fixed scale wastes
 * most of the ramp on a window whose repeats never exceed three while saturating on one that
 * reaches forty. The ramps are rescaled to the busiest ground actually on screen, so they always
 * spend their range on the data in front of you and the labels move with them.
 *
 * Exploration shows two ramps because the map draws two: hue is direction, lightness is count.
 * They share one scale and one set of end labels, which is the visual claim being made -- the
 * same position on either ramp means the same number of visits, so the only thing that differs
 * between them is which way you went.
 *
 * Colour never carries meaning alone: this is always present, and hovering any line reports its
 * exact count and its direction split.
 */
export function Legend() {
  const mode = useStore((s) => s.mode);
  const theme = useStore((s) => s.theme);
  const maxVisit = useStore((s) => s.maxVisit);

  const palette = PALETTES[theme];
  const exploring = mode === 'exploration';
  // Every ramp starts at a single visit. Nothing is held back for ground covered once.
  const lo = 1;
  const hi = Math.max(lo, maxVisit);

  const ramps: Array<{ label: string; stops: string[] }> = exploring
    ? [
        { label: 'one way only', stops: palette.oneWay },
        { label: 'both ways', stops: palette.bothWays },
      ]
    : [{ label: '', stops: palette.heatmap }];

  return (
    <>
      <hr className="rule" />
      <h2 style={{ margin: '0 0 8px' }}>{exploring ? 'Exploration' : 'Visits'}</h2>

      {ramps.map(({ label, stops }) => (
        <div key={label} style={{ marginBottom: exploring ? 9 : 0 }}>
          {label && (
            <div style={{ color: 'var(--text-secondary)', marginBottom: 4 }}>{label}</div>
          )}
          <div
            aria-hidden
            style={{
              height: 8,
              borderRadius: 3,
              background: `linear-gradient(to right, ${stops.join(', ')})`,
              border: '1px solid var(--panel-border)',
            }}
          />
        </div>
      ))}

      {/* One scale under both ramps rather than a pair of identical ones. Repeating the numbers
          would imply the two ramps could be scaled differently, which is exactly the reading
          the shared lightness profile exists to rule out. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 4,
          color: 'var(--text-muted)',
          fontSize: 11,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>{lo === 1 ? '1 visit' : `${lo} visits`}</span>
        <span>{hi <= lo ? '' : `${hi.toLocaleString()}+`}</span>
      </div>
    </>
  );
}
