# Ship as a public, browser-only tool

## Context

The tool is finished for one person: 1,303 activities, 802,411 sites, 3,975 unique miles of
10,639 logged. The ask is to deploy on Vercel so anyone can use it, on the free tier.

**The shape of the product:** the Strava API is the complete path — it can sync a whole history
and keep it current forever. The bulk-export ZIP is an **optional accelerator** that collapses
the slow part (backfilling years of history) from days into a minute. Neither is a fallback for
the other; the ZIP is a shortcut you can take or skip.

### The correction that reshaped this plan

I initially ruled out the API for a public version and was wrong. I claimed a browser couldn't
complete the OAuth exchange. Tested directly:

```
OPTIONS https://www.strava.com/oauth/token      -> access-control-allow-origin: *
OPTIONS https://www.strava.com/api/v3/athlete   -> access-control-allow-origin: *
                                                   allow-methods: GET, POST, PUT, DELETE
```

**Strava's API fully supports CORS.** A static site can run the whole OAuth flow and every API
call from the browser, no server and no proxy. Elevate needed Electron for filesystem access and
Node FIT libraries — not for CORS.

### Why bring-your-own-credentials

Rate limits are **per-application**. On our registration we'd onboard 1-2 people a day and hit
the Standard tier's 10-athlete cap. If each user registers **their own** Strava app, each gets
their own quota and the ceiling disappears.

It also means we have no Strava relationship in the public product at all. The user is the
developer; API Agreement obligations attach to them, for their own data, in their own browser —
the same liability transfer Elevate designed (*"You are responsible of the application you are
going to create"*).

Accepted cost, as you said: **it needs a paid Strava subscription**, because since June 2026
holding API credentials requires one. The ZIP path does not, which is a second reason to have it.

### Why both, and why the ZIP is not optional in the long run

Elevate's API connector is broken *right now* ([issue #1252](https://github.com/thomaschampagne/elevate/issues/1252),
July 2026, still open) — killed by that same paywall, its users told to switch to the file
connector. Every file-based tool (dérive, hotpot, Dawarich) was unaffected. Shipping both means
a Strava policy change degrades the product instead of ending it.

## The merge that makes this work

Both paths produce the same `LedgerInput`, keyed on **Strava activity ID**. In the export, the
activity ID *is* the filename (`activities/12345678.fit.gz`), and `activities.csv` carries it
too. So:

- ZIP fills in history; the API then only fetches `after=<newest activity in the ZIP>` — seconds,
  not days.
- Re-dropping the same ZIP is idempotent.
- A user can start with the API, get impatient, drop a ZIP, and the backfill just stops early.

That single key is what turns two ingestion paths into one coherent product.

## Architecture

Static site, no server, no accounts, no database. Everything in the visitor's browser.

- **Credentials:** user creates their own Strava app, pastes client ID + secret.
- **OAuth:** authorization-code flow in-browser; token exchange direct to Strava.
- **Sync:** newest-first. Last 12 months land immediately and produce real numbers; older
  history backfills in the background, resumable across sessions and days.
- **Expedite:** at any point, drop an export ZIP to fill history instantly.
- **Storage:** raw per-activity streams, tokens, and built artifacts in IndexedDB.
- **Build:** `packages/ledger` in a Web Worker, fed by an IndexedDB cursor.

**Two products, one repo.** Your local pipeline (`scripts/auth.ts`, `sync.ts`,
`build-ledger.ts`) is untouched — still the fastest personal workflow, no wizard.

### What we reuse

`packages/strava` is already browser-safe: no `node:` imports, `fetch`/`Headers`/`zod` only, and
it already parses `X-ReadRateLimit-*`, throws `RateLimitError` with `retryAfterMs`, and
paginates. `packages/ledger` is verified pure TypeScript. The query engine, map, charts and all
existing UI are untouched.

### The one thing that must be true first

`packages/ledger` *runs* in a browser but does not **fit**. A probe on real data:

```
1,306 activities, 6,044,375 GPS points
held as LedgerInput[]  ->  heapUsed 536 MB   (before the algorithm starts)
```

`runLedger` takes the whole history at once (`ledger.ts:320`) and retains `samples: Sample[]`
per activity until Stage 4 (`:324`, `:405`) — ~200 MB more. A naive port peaks near 900 MB:
survives desktop Chrome, dies on Safari.

### One constraint to decide early

Each user sets an **Authorization Callback Domain** in their own Strava app, matching where
we're hosted. Moving domains later forces every existing user to edit that field. Ship on
`*.vercel.app` for your own testing, but **fix the final domain before onboarding anyone else.**

## Milestones

### M0 — Make the ledger fit in a browser (no user-visible change)

- `packages/ledger/src/ledger.ts`: extract `createBuilder(params) -> { add(input), finish(), onProgress }`;
  `runLedger` becomes a thin wrapper. **All 62 existing tests must pass unmodified** — the gate.
- In `processActivity`: write `px`/`py`/`flag` into growable typed arrays inside the loop and
  drop `samples` (`:312`); delete the assigned-but-never-read `siteIds` (`:314`); replace
  `touchDirs: Map` with a `Uint8Array` parallel to sorted touches.
- `index.ts`: accept `Iterable<LedgerInput>` so an IndexedDB cursor streams activities and each
  one's raw arrays free immediately. Keep the array overload so `scripts/build-ledger.ts` is
  untouched.

**Accept:** browser worker builds 1,303 activities in < 25 s, peak heap < 400 MB, and
`manifest.counts` + `totals` identical to the Node build.

### M1 — Pluggable artifact source, IndexedDB, and a live URL

- `app/src/worker/artifactSource.ts`: `{ manifest(), block(n), activities() }` with an IndexedDB
  source and a **dev-only** HTTP source gated on `import.meta.env.DEV`. Five edits in
  `query.worker.ts` (lines 124, 148-152, 548). **Nothing below line 154 changes**, so the query
  engine's correctness is not at risk.
- Storage schema keyed on Strava activity id: `activities` (compact typed arrays —
  `lat`/`lng` as `Int32Array` at 1e7, ~14 bytes/point vs ~90 boxed), `artifacts`, `syncState`,
  `credentials`.
- **Move `app/public/artifacts/` → `.local/artifacts/`**, served in dev by a Vite
  `configureServer` middleware. `vite build` copies `public/` verbatim into `dist/`; moving the
  bytes where the build never looks makes publishing your home coordinates structurally
  impossible rather than a `.gitignore` habit.
- Split root `package.json`: `build` = app only (what Vercel runs), `build:local` = ledger + app.
- Vercel tooling: MCP at `https://mcp.vercel.com` and/or CLI with `VERCEL_TOKEN` (one human step
  to mint the token). `vercel.json` with SPA rewrite and immutable `/assets/*` headers.

**Accept:** identical rendering from IndexedDB and dev-HTTP; `app/dist` contains zero `.bin`;
a live URL.

### M2 — The complete path: credentials wizard, OAuth, sync engine

- `app/src/connect/wizard/` — setup walkthrough on Elevate's proven model: link straight to
  `strava.com/settings/api`, suggest an app name, state the exact **Authorization Callback
  Domain** to paste, show where Client ID and Secret appear. Say the subscription requirement up
  front, not at step 7.
- `app/src/connect/oauth.ts` — authorization-code flow in-browser via `packages/strava/auth.ts`.
  `scope=activity:read_all` (without it, private activities and privacy-zone data go silently
  missing). Persist the rotating refresh token on every refresh, before anything else can throw.
- `app/src/connect/sync.ts`:
  - **Newest-first.** Last 12 months land first and produce real numbers; then walk backwards.
  - **Resumable.** Cursor and per-activity status written to IndexedDB after every activity.
    Closing the tab is safe.
  - **Rate-limit aware.** On 429 honour `Retry-After`, else sleep to the next :00/:15/:30/:45.
    On daily exhaustion, stop cleanly and say "resuming tomorrow" — a normal outcome for a large
    history, not an error.
  - **Honest ETA**, and alongside it the offer: *"~2 days at your quota. Have an export ZIP?
    Skip the wait."*
- Rebuild the ledger after each batch (debounced). Numbers shifting as older history arrives is
  correct, documented behaviour — chronological attribution means an earlier activity claims
  first-visit credit — but the UI must say so rather than let it look like a bug.

**Accept:** a full sync of your own account reproduces your existing API-built
`totals.uniqueMeters` within 1%.

### M3 — The expedite path: ZIP import

- `app/src/import/zip.ts` — central directory + `Blob.slice()` + native
  `DecompressionStream('deflate-raw')`. **Not fflate streaming**: it can't handle entries with a
  trailing data descriptor, and being serial it forfeits the worker pool. Random access lets N
  workers pull independent byte ranges. Type against `Blob`, not `File`, so it tests in Node.
  *Encode as a test:* the central directory's `extraFieldLength` differs from the local header's;
  the true data offset needs a 30-byte re-read at the local header.
- `app/src/import/csv.ts` — **headers are localized per account**; key on aliases.
- `app/src/import/sportType.ts` — the CSV carries display strings (`"Trail Run"`,
  `"E-Bike Ride"`), not camelCase `sport_type`. Without a normalizer, `params.ts:91` sends
  **every** activity to `other` and `preprocess.ts:45`'s `startsWith('Virtual')` stops excluding
  virtual rides. Both fail silently. (This is Elevate's #1252 complaint too.)
- Parsers `{fit,gpx,tcx,detect}.ts`, pure `(bytes) -> ParsedTrack | ParseError`, in a worker
  pool. `@garmin/fitsdk` (29 ms/file, ~17x faster than `fit-file-parser`), dynamically imported
  **inside the parse worker only** — its profile tables are ~500 KB. *Two constants:* positions
  are semicircles (`deg = semi * 180 / 2^31`); timestamps are seconds since 1989-12-31.
  GPX/TCX get hand-rolled `indexOf` scanners — `DOMParser` doesn't exist in workers.
- Merge by activity id; then narrow the API backfill to `after=<newest imported>`.

**Accept — differential test:** ZIP-imported history and API-synced history for the same account
produce `totals.uniqueMeters` within 1% of each other. One check proves the ZIP reader, all
three parsers, the CSV join, and the sport-type normalizer at once.

### M4 — Onboarding, progress, and the honesty layer

- Delete `app/src/panels/Setup.tsx` — it currently tells strangers to run `npm run auth`.
  Replace with `Landing.tsx`, `ConnectFlow.tsx`, `SyncProgress.tsx`, `ImportReport.tsx`.
- Landing: what the tool computes, the two numbers in a sentence each, the privacy promise
  stated at the connect button rather than in a footer.
- **`ImportReport.tsx` is launch-blocking.** `excluded()` (`preprocess.ts:42-71`) silently drops
  trainer / manual / virtual / no-GPS / stream-mismatch / treadmill activities. On a stranger's
  history that can be hundreds, producing a plausible map and a number 40% low with no signal.
  Must reconcile `included + excluded == activities seen`, per reason, for both paths.
- Progress on Elevate's sync-bar model: non-blocking ribbon, line 1 the **named** current
  activity, line 2 a running count with a real percentage, a `{n} warnings` button that
  accumulates without interrupting, and a Stop button.
- Invert the load state machine (`App.tsx:304` forks the whole tree on `load !== 'ready'`).
- **Cut place search.** Nominatim's policy forbids public autocomplete backends and a browser
  can't set the identifying User-Agent it requires. Keep activity-name search — local, instant,
  the more-used half. (`SearchBox.tsx:73-102`, ~60 lines out.)

### M5 — Resilience and launch

- `navigator.storage.estimate()` before syncing; `persist()` in a user gesture; report the honest
  result (Safari never grants it and evicts after 7 idle days).
- `QuotaExceededError` degrades in a defined order: drop `tracks.bin` (19 MB, costs playback
  highlight), then raw streams. Never silently blank.
- **Disconnect / delete my data** clearing IndexedDB and tokens — a hard requirement.
- React error boundary (there is none; any throw white-screens the page).
- Desktop-only interstitial below ~700 px — panels are fixed-width and collide.
- `app/index.html`: title, meta description, favicon, OG image.

## Pre-launch checklist

1. DevTools Network through a full sync and a full ZIP import: only Strava's API, the basemap,
   and our bundle. No analytics, no error reporter, no third-party scripts. Ship a CSP so it's
   enforceable rather than aspirational.
2. `app/dist` contains no `.bin`, no `artifacts/`.
3. Tokens live only in the user's IndexedDB, never logged, including in error messages.
4. Tested by at least one person who is not you, on their own account.
5. Chrome, Safari **and Firefox** on desktop. Safari is the one that will break.
6. `git clone && npm ci && npm -w app run build` succeeds with no `data/` directory.
7. Privacy statement; "not affiliated with Strava"; no Strava logo — but the **"Connect with
   Strava" button is required** by their brand guidelines for OAuth and must link to the
   official authorize endpoint. Vercel Hobby is non-commercial: no ads, no sponsor links.
8. OSM/OpenFreeMap attribution renders and isn't hidden behind a panel.
9. Final domain fixed before anyone else sets their callback domain.

## Verification

- `npx vitest --run` — 62 existing tests stay green through M0; new suites for the sync state
  machine (resume, 429 backoff, daily exhaustion) against a stubbed fetch, never the live API;
  ZIP reader, CSV, sport-type normalizer, and each parser against committed fixtures.
- The two differential tests (M2 and M3) are the strongest acceptance signals available.
- After deploy: clean profile → wizard → OAuth → 12-month sync → real numbers; drop a ZIP and
  confirm history fills and the backfill stops early; close the tab mid-sync and confirm resume;
  reload and confirm IndexedDB renders in under 3 s.

## Open items

**Name / domain.** Two batches rejected. A different angle — name the number, not the terrain:
`newtome` ("new to me" is literally what the gold layer shows), `netnew`, `onceonly`,
`firsttime`. Needs deciding before public onboarding because of the callback-domain constraint,
but not before M0-M2.

**SPEC.md must be amended, not left contradicting the product.** It locks "Audience: single
athlete", "Runtime: local-first", "Heavy compute runs in Node, not the browser", and non-goals
including multi-user — and says *do not relitigate*. Amend §1.3/§1.4/§3.3/§6.6/§7 to split local
vs public, and add a §0 stating the privacy invariant.
