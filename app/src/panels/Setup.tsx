/** SPEC.md section 6.6. Missing artifacts are a setup state, not an error. */

const STEPS = [
  ['npm run auth', 'one time: authorize with Strava in your browser'],
  ['npm run sync', 'crawl activities and GPS streams into data/ (resumable, slow on a first run)'],
  ['npm run build:ledger', 'run the ledger, write app/public/artifacts/'],
];

export function Setup({ state, message }: { state: string; message: string }) {
  const mismatch = state === 'format-mismatch';
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="panel" style={{ position: 'relative', maxWidth: 560, padding: '22px 26px' }}>
        <h2 style={{ marginBottom: 14 }}>{mismatch ? 'Artifacts need rebuilding' : 'Set up unique miles'}</h2>

        {mismatch ? (
          <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
            {message} Run <code style={{ fontFamily: 'var(--mono)' }}>npm run build:ledger</code> to
            regenerate them.
          </p>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', marginTop: 0 }}>
              No artifacts yet. Run these from the project root, in order:
            </p>
            <ol style={{ paddingLeft: 20, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              {STEPS.map(([cmd, why]) => (
                <li key={cmd}>
                  <code
                    style={{
                      fontFamily: 'var(--mono)',
                      background: 'rgba(255,255,255,0.07)',
                      padding: '2px 6px',
                      borderRadius: 4,
                      color: 'var(--text-primary)',
                    }}
                  >
                    {cmd}
                  </code>
                  <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{why}</div>
                </li>
              ))}
            </ol>
            <p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>
              Details in docs/data-pipeline.md. Reload this page once the build finishes.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
