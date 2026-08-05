import { useMemo } from 'react';
import { useStore } from '../state/store.js';
import { Legend } from './Legend.js';

export function FilterPanel() {
  const { manifest, activities, groups, mode, filtersOpen, hillshade } = useStore();
  const toggleGroup = useStore((s) => s.toggleGroup);
  const set = useStore((s) => s.set);

  // Counts are of INCLUDED activities: trainer, manual, virtual and GPS-less ones are absent
  // from the artifacts entirely and are counted nowhere.
  const counts = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of activities) m.set(a.group, (m.get(a.group) ?? 0) + 1);
    return m;
  }, [activities]);

  if (!manifest) return null;

  return (
    <div className="panel" style={{ top: 12, left: 12, width: 210 }}>
      <h2>
        Filters
        <button onClick={() => set({ filtersOpen: !filtersOpen })} aria-label="Toggle filters">
          {filtersOpen ? '−' : '+'}
        </button>
      </h2>
      {filtersOpen && (
        <>
          <div style={{ marginBottom: 10 }}>
            {manifest.sportGroups.map((name, i) => {
              const n = counts.get(i) ?? 0;
              if (n === 0) return null;
              return (
                <label className="check" key={name}>
                  <input type="checkbox" checked={groups.includes(i)} onChange={() => toggleGroup(i)} />
                  <span style={{ textTransform: 'capitalize' }}>{name}</span>
                  <span className="count">{n.toLocaleString()}</span>
                </label>
              );
            })}
          </div>

          <hr className="rule" />

          <h2 style={{ margin: '0 0 6px' }}>Map mode</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="chip"
              aria-pressed={mode === 'exploration'}
              onClick={() => set({ mode: 'exploration' })}
            >
              Exploration
            </button>
            <button className="chip" aria-pressed={mode === 'heatmap'} onClick={() => set({ mode: 'heatmap' })}>
              Heatmap
            </button>
          </div>

          <label className="check" style={{ marginTop: 10 }} title="Shaded relief from AWS Terrain Tiles">
            <input
              type="checkbox"
              checked={hillshade}
              onChange={() => {
                const next = !hillshade;
                localStorage.setItem('um.hillshade', next ? '1' : '0');
                set({ hillshade: next });
              }}
            />
            <span>Terrain</span>
          </label>

          <Legend />
        </>
      )}
    </div>
  );
}
