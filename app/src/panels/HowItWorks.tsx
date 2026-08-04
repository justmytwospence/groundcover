/**
 * SPEC.md section 6.7. Users will find these edge cases; the tool should have told them first.
 * Do not soften or remove the limitations list.
 */

export function HowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--scrim)',
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
      }}
      onClick={onClose}
    >
      <div
        className="panel"
        style={{ position: 'relative', maxWidth: 620, maxHeight: '80vh', overflow: 'auto', padding: '18px 22px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>
          How this is calculated
          <button onClick={onClose} aria-label="Close">
            ×
          </button>
        </h2>

        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65 }}>
          <p>
            <strong style={{ color: 'var(--text-primary)' }}>Distinct ground</strong> is how much
            non-overlapping ground you covered inside the current selection, ignoring everything
            outside it. A road run forty times in one year counts once.
          </p>
          <p>
            <strong style={{ color: 'var(--frontier)' }}>New ground</strong> is how much of that was
            ground you had never covered before, at any point in your history. It can never exceed
            distinct ground.
          </p>
          <p>
            Every activity is resampled to a point every 8 metres, and those points are matched
            against everywhere you have already been. Ground within about 20 metres of a previous
            pass counts as the same ground; beyond about 30 metres it counts as new. The gap between
            is deliberate: it is what stops years of GPS wobble along a familiar road from slowly
            inventing new mileage.
          </p>

          <h3 style={{ color: 'var(--text-primary)', fontSize: 13, marginBottom: 4 }}>
            Known limitations
          </h3>
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            <li>Paths less than about 20 metres apart merge. A separated bike path beside a road counts as the road.</li>
            <li>
              Switchback legs 10 to 20 metres apart merge unless the activity recorded barometric
              altitude, and they merge near every turn regardless. This is a genuine limitation of
              measuring coverage from GPS geometry alone.
            </li>
            <li>
              Roads 20 to 30 metres apart earn nothing; between 30 and about 40 they earn partial,
              permanent credit. Full credit resumes past roughly 40 to 45 metres.
            </li>
            <li>Genuinely new fragments shorter than 24 metres are never credited.</li>
            <li>Small closed loops, under about 100 metres around, are only partially credited.</li>
            <li>
              Trainer, manual, virtual and GPS-less activities are excluded from every number here,
              including total logged, so these totals will not match Strava&apos;s.
            </li>
          </ul>

          <p style={{ marginBottom: 0, color: 'var(--text-muted)' }}>
            Every one of these is bounded, deterministic, and the same every time you rebuild.
          </p>
        </div>
      </div>
    </div>
  );
}
