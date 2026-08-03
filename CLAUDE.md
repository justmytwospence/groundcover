# unique-miles

Personal Strava heatmap that computes deduplicated ("unique") mileage. Read `SPEC.md` first,
then `docs/build-plan.md`. This file carries only what those documents cannot tell you.

## Credentials

- `.env.local` holds `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`. `.strava-token.json` holds
  the rotating refresh token. Both are gitignored. **Never print, log, or echo a token value.**
- Strava allows one API application per account, so this project shares the registration
  other tools on the same account use. It holds its **own** refresh token in its
  own `.strava-token.json` and must never read or write the another tool's token stores (a server-side store
  `a shared key`, `another store`, `another store`). See `docs/data-pipeline.md`
  section 1.2.
- The rate-limit budget is shared with another tool. A long backfill running alongside a another tool sync
  makes both see 429s; both retry, so it degrades rather than breaks.
- If auth breaks, re-run `npm run auth`. Deleting `.strava-token.json` first is safe.

## Commands

```bash
npm run auth          # one time, interactive: OAuth in the browser
npm run sync          # crawl new activities + GPS streams into data/  (resumable, slow)
npm run build:ledger  # data/ -> app/public/artifacts/  (full rebuild, seconds)
npm run stats         # text summary of the current artifacts; use this to smoke-check a build
npm run dev           # app at localhost:5173
```

Routine refresh after new activities: `npm run sync && npm run build:ledger`.

## Gotchas

- `npm run sync` on a first backfill takes hours and may exhaust the daily API read cap. That
  is expected. It exits cleanly and resumes where it stopped; just run it again.
- `npm run build:ledger` is a full rebuild every time, by design — it is what makes
  chronological credit attribution stable when older activities arrive out of order.
- `data/` and `app/public/artifacts/` are gitignored and regenerable. Nothing in them is
  precious except the hours of API budget spent filling `data/streams/`. Do not delete that
  directory casually.
- CI does not run `build:ledger` (it needs the gitignored `data/`). The ledger is covered by
  `npm test`.
- The algorithm's tests in `packages/ledger/src/__tests__/` are the specification. Several of
  them deliberately assert *documented failures* (A6b, A9c). If one of those starts passing,
  that is a signal to review, not a bug to fix silently.
- Map colors were validated with a palette checker, not chosen by eye. If you change any value
  in `app/src/theme.css`, re-validate rather than eyeballing (see `SPEC.md` section 6.2).
