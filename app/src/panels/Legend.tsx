import { useStore } from '../state/store.js';
import { PALETTES } from '../lib/theme.js';

/**
 * The key to the map: a continuous ramp rather than named bands.
 *
 * Rendered inside the filter panel rather than as its own floating box. It reads as part of the
 * map-mode control it describes -- the ramp changes when the mode does -- and one panel fewer is
 * one less thing occupying a corner of somebody's map.
 *
 * The bands were arbitrary. "5-9" says nothing about anybody's history, and a fixed scale wastes
 * most of the ramp on a window whose repeats never exceed three while saturating on one that
 * reaches forty. The gradient is rescaled to the busiest ground actually on screen, so it always
 * spends its range on the data in front of you and the labels move with it.
 *
 * The frontier stays a reserved colour rather than becoming the ramp's first stop. A gold-to-blue
 * ramp cannot be monotone in lightness on a dark surface -- gold sits near the top of the blue
 * range, so hue and magnitude fight -- and a ramp you cannot read by brightness is not a ramp.
 *
 * Colour still never carries meaning alone: this is always present, and hovering any line reports
 * its exact count.
 */
export function Legend() {
  const mode = useStore((s) => s.mode);
  const theme = useStore((s) => s.theme);
  const maxVisit = useStore((s) => s.maxVisit);

  const palette = PALETTES[theme];
  const exploring = mode === 'exploration';
  // Both ramps begin at one now. Exploration's used to begin at two, when the frontier owned
  // every single-visit site; a first-time out-and-back is both-ways ground at a count of one.
  const lo = 1;
  const hi = Math.max(lo, maxVisit);
  const stops = exploring ? palette.gradient : palette.heatmap;

  return (
    <>
      <hr className="rule" />
      <h2 style={{ margin: '0 0 8px' }}>{exploring ? 'Exploration' : 'Visits'}</h2>

      {exploring &&
        (
          [
            ['var(--frontier)', 'new ground', 'once'],
            ['var(--one-way)', 'one way only', 'never back'],
          ] as const
        ).map(([swatch, label, note]) => (
          <div
            key={label}
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}
          >
            <span
              style={{ width: 18, height: 3, borderRadius: 2, background: swatch, flex: '0 0 auto' }}
            />
            <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>
              {note}
            </span>
          </div>
        ))}

      {/* The ramp needs naming now that it is one of three things on the key rather than the
          only one: in exploration mode it is specifically the both-directions ground. */}
      {exploring && (
        <div style={{ color: 'var(--text-secondary)', marginBottom: 5 }}>both ways</div>
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
