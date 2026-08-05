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
  // Exploration reserves one visit for the frontier, so its ramp begins at two.
  const lo = exploring ? 2 : 1;
  const hi = Math.max(lo, maxVisit);
  const stops = exploring ? palette.gradient : palette.heatmap;

  return (
    <>
      <hr className="rule" />
      <h2 style={{ margin: '0 0 8px' }}>{exploring ? 'Exploration' : 'Visits'}</h2>

      {exploring && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 9 }}>
          <span
            style={{
              width: 18,
              height: 3,
              borderRadius: 2,
              background: 'var(--frontier)',
              flex: '0 0 auto',
            }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>new ground</span>
          <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>once</span>
        </div>
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
