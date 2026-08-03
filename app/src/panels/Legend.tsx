import { useStore } from '../state/store.js';

/**
 * The two modes have different band counts, so the row set is per-mode, not static.
 * Colour never carries meaning alone: this legend is always present.
 */
const EXPLORATION_ROWS = [
  { c: 'var(--frontier)', label: 'frontier', range: '1 visit' },
  { c: 'var(--repeat-1)', label: 'familiar', range: '2-4' },
  { c: 'var(--repeat-2)', label: 'known', range: '5-9' },
  { c: 'var(--repeat-3)', label: 'worn in', range: '10+' },
];

const HEATMAP_ROWS = [
  { c: 'var(--heat-1)', label: '1 visit', range: '' },
  { c: 'var(--heat-2)', label: '2-4', range: '' },
  { c: 'var(--heat-3)', label: '5-9', range: '' },
  { c: 'var(--heat-4)', label: '10-24', range: '' },
  { c: 'var(--heat-5)', label: '25+', range: '' },
];

export function Legend() {
  const mode = useStore((s) => s.mode);
  const rows = mode === 'exploration' ? EXPLORATION_ROWS : HEATMAP_ROWS;

  return (
    <div className="panel" style={{ right: 12, bottom: 150, width: 168, padding: '10px 12px' }}>
      <h2 style={{ marginBottom: 6 }}>{mode === 'exploration' ? 'Exploration' : 'Visits'}</h2>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
          <span style={{ width: 18, height: 3, borderRadius: 2, background: r.c, flex: '0 0 auto' }} />
          <span style={{ color: 'var(--text-secondary)' }}>{r.label}</span>
          {r.range && (
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>{r.range}</span>
          )}
        </div>
      ))}
    </div>
  );
}
