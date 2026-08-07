/**
 * The publish deployment's one piece of chrome: what this is, when it last moved, and where to
 * go to make your own.
 *
 * It sits where the BYO build puts AccountPanel, which is the only slot in the left rail that
 * is free here -- the published map has no account, no sync and nothing to erase.
 *
 * "Powered by Strava" is the wording the Strava brand guidelines require; the app's own name
 * must not contain "Strava", and nothing here may imply endorsement.
 */

const OWN_MAP_URL = import.meta.env.VITE_PUBLISH_BYO_URL as string | undefined;

function formatBuiltAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;

  const ageMin = Math.floor((Date.now() - ts) / 60000);
  if (ageMin < 90) return 'updated just now';
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 36) return `updated ${ageHr} hours ago`;
  return `updated ${new Date(ts).toISOString().slice(0, 10)}`;
}

export function PublishedFooter({ builtAt }: { builtAt?: string }) {
  const age = formatBuiltAt(builtAt);

  return (
    <div className="panel" style={{ width: 232 }}>
      <div style={{ color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>GroundCover</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 11.5, lineHeight: 1.5, marginTop: 3 }}>
        Deduplicated coverage, not a heatmap of repeats. Powered by Strava
        {age ? ` · ${age}` : ''}.
      </div>
      {OWN_MAP_URL && (
        <a
          className="ghost"
          href={OWN_MAP_URL}
          // Opening in a new tab keeps a visitor's place on this map, and noopener is not
          // optional on a target=_blank link to a different origin.
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            marginTop: 9,
            textDecoration: 'none',
            fontSize: 12,
          }}
        >
          Map your own →
        </a>
      )}
    </div>
  );
}
