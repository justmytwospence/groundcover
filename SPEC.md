# GroundCover

A personal, local-first web tool that pulls one athlete's Strava history and answers a
question no other heatmap answers: **how much distinct ground have I actually covered?**

It renders a heatmap of everywhere you have been, and computes the deduplicated mileage
behind it — filterable by time, sport, and map viewport, with time-lapse playback of how
your coverage grew.

This document is the master spec. Two companion documents carry the detail:

| Document | Contents |
|---|---|
| `docs/algorithm.md` | The SiteLedger v2 uniqueness algorithm: parameters, pseudocode, failure modes, test suite |
| `docs/data-pipeline.md` | Strava app setup, auth, sync CLI, on-disk formats, artifact binary layouts |
| `docs/build-plan.md` | Ordered implementation milestones with acceptance criteria |

Read this file first, then `docs/build-plan.md`, then the other two as each milestone
requires them.

---

## 0. The privacy invariant

**One person's coverage at 8 m resolution is their home address, their commute, and their
routine.** Everything below is subordinate to that.

1. No GPS, no artifact, and no token belonging to any person may ever be committed to this
   repository or included in a build of **the BYO product**. This is enforced structurally, not
   by discipline: built artifacts live in `.local/artifacts/`, which is outside every directory
   `vite build` copies from, and `.vercelignore` names `data/` and `.local/` explicitly so a
   deploy cannot upload them even if `.gitignore` changes.

   The **publish deployment** (section 4.6) is the one deliberate exception, and it is scoped
   rather than trusted. It is a separate Vercel project, deployed from a separate staged tree,
   carrying only the owner's own artifacts and only because the owner asked for them to be
   public. It changes nothing about the BYO product: that bundle still contains no code path
   that fetches coverage over a network, which is checked by building it and confirming the
   published artifact source is absent, not by assuming the bundler removed it.

   Nobody else's data is ever in scope for either. A visitor's history still moves from Strava
   to their own browser and stops there.
2. In the public product there is no server, no account and no database. A visitor's history
   moves from Strava to their own browser and stops there. The `Content-Security-Policy` in
   `vercel.json` names Strava and the basemap in `connect-src` and nothing else, so this is
   enforced by the browser rather than promised in a footer.
3. Token and secret values are never logged, printed, embedded in an error message, or put
   in a URL. Error paths carry HTTP status codes only.
4. The dev-only HTTP artifact source in `app/src/worker/artifactSource.ts` is gated on
   `import.meta.env.DEV` so a production bundle contains no code path that fetches anyone's
   coverage over a network.

If a future change makes any of these harder to guarantee, that is a reason to reject the
change, not to weaken the invariant.

---

## 1. Product definition

### 1.1 The core idea

Every heatmap tool (Strava's own, statshunters, bifurkate) shows you *where* you went.
None of them tell you how much of it was *new*. If you run the same 5-mile loop 200 times,
a heatmap shows a bright loop and your annual total says 1,000 miles. The honest answer to
"how much ground have you covered" is 5 miles.

GroundCover computes both numbers and shows them side by side, and colors the map so the
distinction is visible: the ground you have covered exactly once (your frontier) is
rendered in a reserved accent color; ground you have worn in is rendered in a
brightness ramp by how many times you have been there.

### 1.2 The two mileage numbers

These are different questions and the UI must never conflate them. Both are always
displayed, with equal billing.

**Distinct ground (semantics A)** — how much non-overlapping ground did I cover inside the
current selection, ignoring everything outside it? Filter to 2024 and this answers "in
2024 I covered 312 distinct miles" — a road run 40 times in 2024 counts once.

**New ground (semantics B)** — how much of the current selection was ground I had *never*
covered before, at any point in my history? Filter to 2024 and this answers "84 of those
miles were places I had never been." Necessarily `B <= A`.

Also always shown: **total logged** (the raw sum of recorded distances of the GPS activities
in the selection — excluded trainer, manual, and virtual activities are not counted, so this
will not match Strava's own yearly totals) and **repeat ratio** (`1 - A/total`).

Scrubbing the timeline with B as your eye's anchor tells the exploration story: big B in
your first year in a city, shrinking B as you exhaust the neighborhood, a spike when you
travel. A tells you how much ground a given period actually touched.

### 1.3 Locked product decisions

These were decided during spec review. Do not relitigate them during implementation.

| Decision | Choice |
|---|---|
| Uniqueness method | Geometry-only (SiteLedger v2). No OpenStreetMap, no map matching, no routing engine. |
| Data ingestion | Strava API. OAuth once, then resumable rate-limited backfill, then incremental sync. A bulk-export ZIP is an optional accelerator for the backfill, never a prerequisite. |
| Strava app | Local pipeline: reuses the owner's existing registration. Public product: **each visitor registers their own** (see 4.2). |
| Audience | Two deployments of one codebase. The local pipeline serves one athlete; the public build serves anyone, with no accounts and no shared state — every visitor is independently self-contained. |
| Runtime | The public build computes everything in the visitor's browser. The local pipeline still precomputes in Node, which remains the fastest personal workflow. |
| Heavy compute | Runs wherever the data is: a Node script locally, a Web Worker in the public build. `packages/ledger` is the same pure code in both. |
| Layout | Full-bleed map with floating translucent control panels. |
| Default map mode | Exploration (first-visit vs repeat coloring). Classic frequency heatmap is one toggle away. |
| v1 feature set | Heatmap + both mileage numbers + time/sport/viewport filters + time-lapse playback + exploration/heatmap modes + stats dashboard. |

### 1.4 Non-goals for v1

Explicitly out of scope. Do not build these; do not add extension points for them beyond
what is already noted.

- OpenStreetMap integration of any kind: no untraveled-roads overlay, no "percent of city
  complete", no per-street names. (Deferred: see 3.5 for the one hook that keeps it possible.)
- Explorer-tile gamification (zoom-14 tiles, max square, max cluster, badges).
- Login, accounts, server-side state, or sharing another person's map. The public build is
  multi-*visitor* but never multi-user: there is nothing shared to log in to.
- Strava webhooks. Sync is a manual command.
- Route planning, segment analysis, training metrics, heart rate, power.
- Mobile-first design. It must not be broken on a tablet, but the target is a desktop browser.
- Any upload of GPS data to a third-party service.

---

## 2. How it works, end to end

```
  Strava API                Local disk                  Node build              Browser
  ----------                ----------                  ----------              -------
  /athlete/activities  -->  data/summaries.json
  /activities/{id}/       \
    streams            -->  data/streams/{id}.json.gz
                                   |
                                   v
                            scripts/build-ledger.ts
                            (packages/ledger, pure TS)
                                   |
                                   v
                            app/public/artifacts/
                              manifest.json
                              sites.bin        --------> load once into a Web Worker
                              touches.bin      -------->   |
                              activities.json  -------->   | fold over selected activities
                              tracks.bin (lazy) ------->   v
                                                         color buffer + 4 stat numbers
                                                           |
                                                           v
                                                    deck.gl LineLayer over
                                                    MapLibre dark basemap
```

Four commands, in order:

```bash
npm run auth      # one time: OAuth dance, writes .strava-token.json
npm run sync      # crawls new activities + their GPS streams into data/  (resumable)
npm run build     # runs the ledger over data/ into app/public/artifacts/, then builds the app
npm run dev       # serves the app at localhost:5173
```

`npm run sync && npm run build` is the routine refresh after new activities.

---

## 3. Architecture

### 3.1 Repo layout

```
groundcover/
  SPEC.md
  CLAUDE.md                      operational notes (creds location, commands, gotchas)
  docs/
    algorithm.md
    data-pipeline.md
    build-plan.md
  package.json                   npm workspaces root
  package-lock.json
  eslint.config.js               flat config
  tsconfig.json                  base config, project references
  .gitignore                     .env.local, .strava-token.json, data/, app/public/artifacts/
  .env.local                     GITIGNORED. STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET
  .strava-token.json             GITIGNORED. rotated refresh token, written by auth + sync

  packages/
    strava/                      @um/strava - thin Strava API client
      src/{auth,client,crawl,types}.ts
      src/__tests__/
    ledger/                      @um/ledger - the algorithm. PURE TS, NO NODE APIS.
      src/{preprocess,match,ledger,artifacts,geo,params,types}.ts
      src/__tests__/            synthetic adversarial suite (see docs/algorithm.md section 10)

  scripts/                       run with tsx
    auth.ts                      one-time OAuth, writes .strava-token.json
    sync.ts                      resumable crawl of summaries + streams into data/
    build-ledger.ts              data/ -> app/public/artifacts/
    stats.ts                     prints a text summary of the current artifacts (debugging)

  app/                           Vite + React + TypeScript, static build
    index.html
    vite.config.ts
    public/artifacts/            GITIGNORED. build output consumed by the app
    src/
      main.tsx
      App.tsx
      state/store.ts             zustand store + URL-hash sync
      worker/query.worker.ts     loads artifacts, runs folds, returns stats + color buffer
      worker/queryClient.ts      typed postMessage wrapper around the worker
      map/MapView.tsx            MapLibre + deck.gl overlay
      map/layers.ts              coverage layer, active-track layer, color ramps
      panels/FilterPanel.tsx
      panels/StatsCard.tsx
      panels/StatsDrawer.tsx
      panels/Legend.tsx
      panels/Scrubber.tsx        histogram + brush + playback transport
      charts/                    hand-rolled SVG chart primitives
      theme.css                  design tokens (see section 6.2)

  data/                          GITIGNORED
    summaries.json               all activity summaries, keyed by id
    streams/{id}.json.gz         per-activity latlng/time/altitude streams
    sync-state.json              cursor + per-activity fetch status for resumability
```

### 3.2 Stack and conventions

Conventions:

- TypeScript everywhere. `npm` with `package-lock.json` (never pnpm or yarn).
- npm workspaces for `packages/*` and `app`.
- Vite + React 19 + TypeScript for the app (the small-client-tool lane, like `drainage`
  and `swipe-sort`), **not** Next.js — there is no server.
- `zustand` for app state.
- `zod` to validate every Strava API response at the boundary.
- `vitest --run` for tests, `__tests__/` directories, fixtures alongside.
- `tsx` to run scripts.
- eslint flat config; `tsc --noEmit` for typecheck.
- npm scripts: `dev`, `build`, `preview`, `lint`, `typecheck`, `test`, plus `auth`, `sync`,
  `build:ledger`, `stats`.
- Atomic conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`)
  straight to `main`. No PRs. No `Co-Authored-By` lines.
- No emojis in code, comments, docs, or UI copy.

New dependencies beyond the above, all justified:

| Package | Why |
|---|---|
| `maplibre-gl` | Vector basemap. Free, no API key with OpenFreeMap. |
| `deck.gl` (`@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/mapbox`) | Renders roughly a million line segments with binary attributes and supports swapping just the color buffer on every filter change. MapLibre alone cannot repaint that many features interactively. |
| `pako` | gzip for the on-disk stream cache. |

Do **not** add: a charting library (charts are hand-rolled SVG, see 6.5), turf.js (the
geometry needed is a dozen lines and turf's per-call overhead is the wrong shape for
million-point loops), h3-js (benchmarked at ~0.4M ops/s with a known regression to ~36k;
an integer Mercator grid is orders of magnitude faster and is what the algorithm specifies).

### 3.3 Where the heavy compute runs

Both, from identical code. `packages/ledger` is a pure function of `(activities, params)`,
so the only question is who calls it.

**Public build:** `app/src/worker/build.worker.ts` streams activities out of IndexedDB into
`createBuilder()` and writes the artifacts back. It must stream rather than gather: holding a
real history as `LedgerInput[]` costs ~536 MB before the algorithm starts, which survives
desktop Chrome and kills Safari. Feeding one activity at a time keeps the peak near 190 MB.

**Local pipeline:** `scripts/build-ledger.ts` in Node. Running it there means:

- The algorithm package is a pure function of `(sorted activities, params)`, unit-testable
  with `vitest` and golden files, with no worker lifecycle, no `postMessage` marshalling,
  and no IndexedDB quota handling.
- The browser only ever loads finished typed arrays and runs simple folds over them, which
  is the part that genuinely has to be interactive.
- The static-deploy-later path works unchanged: artifacts are just files.

The cost is that adding one activity requires re-running `npm run build:ledger`, which takes
seconds. That is an acceptable trade for a tool refreshed a few times a week.

`packages/ledger` must therefore contain **no Node APIs** (`fs`, `path`, `Buffer`). It takes
plain data in and returns `ArrayBuffer`s and plain objects out. `scripts/build-ledger.ts`
owns all I/O for the local path and `build.worker.ts` owns it for the public one. That
constraint is what let the browser build exist at all, without a rewrite.

### 3.4 The query engine

Everything interactive reduces to two linear passes over typed arrays. There is no spatial
index at query time, no binary search, no bitset library. Measured worst case at the reference
scale of 3,000 activities and roughly 1M sites is 20-40 ms, which is inside the 100 ms
interactivity budget with room to spare. Do not replace this with something cleverer.

**Pass 1 — the fold.** Given the selected time window and sport groups, iterate the
activities that qualify — an activity qualifies iff `t0 <= startTs <= t1`, **inclusive on both
ends**, deliberately matching the inclusive test in pass 2 so that `B <= A` is provable at
window boundaries. For each, walk its sorted list of touched site ids from
`touches.bin` and increment `visitCount[siteId]` (a `Uint16Array` of length `nSites`,
zeroed per query). Because each activity's touch list is deduplicated at build time, a
site's visit count is the **number of distinct qualifying activities that covered that
ground** — which is exactly what the map should color by. Total work equals the number of
`(activity, site)` touch pairs in the selection, at most ~3.5M.

**Pass 2 — the scan.** Walk all `nSites` sites once:

- If `visitCount[i] > 0` and the site is inside the viewport (when the viewport filter is
  on), add `creditCm[i]` to **distinct ground (A)**.

  The viewport test is a plain axis-aligned box comparison in Web Mercator centimetres, the
  space `sites.bin` already stores, so it costs two comparisons per site and no conversion. The
  main thread sends `{ minX, minY, maxX, maxY }` in that space, computed by taking MapLibre's
  `map.getBounds()` (which returns the bounding box of the visible region, already correct for
  a rotated or pitched map) and projecting its corners. A rotated map therefore filters by a
  slightly larger box than the literal on-screen quadrilateral. That is the intended behavior:
  a site just off the corner of a tilted view still counts, which is far less surprising than
  numbers that shift when you spin the map.
- Compute `firstTs = min over selected groups g of firstTsByGroup[g][i]`. If
  `t0 <= firstTs <= t1` and the site passes the viewport test, add `creditCm[i]` to
  **new ground (B)**.
- Write the site's RGBA bytes into the color buffer from `visitCount[i]` and the active map
  mode.

Pass 2 also produces the color buffer, so rendering costs nothing extra.

**Playback optimization.** Both window modes fold incrementally, keeping the `visitCount`
array between frames along with two cursors into the `startTs`-sorted activity list. When `t1`
advances from `prevT1`, fold in the activities with `prevT1 < startTs <= t1` (incrementing
`visitCount` for each touched site). In Sliding mode, also fold *out* the activities leaving
at the `t0` edge by decrementing. Decrementing is valid precisely because touch lists are
deduplicated at build time, so every qualifying activity contributes exactly +1 per touched
site.

Any sport-group change, or any non-monotonic window change — a backward scrub, a preset chip,
a mode switch — discards the kept `visitCount` and cursors and refolds from scratch. Viewport
changes do not, since the viewport only affects pass 2. Pass 2 runs every frame regardless.
This keeps playback frames under about 10 ms.

Semantics note that must be reflected in the UI copy: **the sport filter restricts the
universe**, it does not post-filter results. Selecting "Foot" computes both numbers as if
only foot activities existed. That is why `firstTsByGroup` is stored per sport group.

### 3.5 The one hook kept for a future OSM layer

Sites are stable, addressable, chronologically-minted points with a position and bearing.
If an OSM map-matching layer is ever added, it would attach `(osmWayId, fraction)` to each
site as an extra column in `sites.bin` without touching the algorithm, the query engine, or
the UI. Nothing else about v1 needs to anticipate it. Do not build any part of it now.

---

## 4. Data pipeline summary

Full detail in `docs/data-pipeline.md`. The load-bearing points:

### 4.1 The Strava application

Strava allows one API application per account. Register one at
<https://www.strava.com/settings/api>, or reuse the one you already have; either way its
`STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` go in this project's own gitignored `.env.local`.

The Authorization Callback Domain must be `localhost` for `npm run auth` to complete. Strava
matches on domain rather than port, so the callback at `http://localhost:8721/callback` works
without further configuration.

Read limits are whatever the app is provisioned for: 100 reads per 15 minutes and 1,000 per
day in Single Player Mode, doubled by the self-service upgrade to 10 athletes in the API
Settings Dashboard. Applying that upgrade is worthwhile and harmless to anything else using
the same registration.

### 4.2 The refresh-token hazard

Strava rotates the refresh token on every refresh and invalidates the previous one
immediately. Any two consumers holding copies of the same token therefore invalidate each
other, and the failure is silent until one of them next tries to refresh.

So GroundCover performs its **own** OAuth authorization, holds its **own** refresh token in
its own `.strava-token.json`, never reads or writes any other store, and persists every
rotation the moment it happens. If you use the same application elsewhere, give that tool its
own authorization too rather than copying a token between them.

Rate limits belong to the application rather than to a consumer, so anything else on the same
registration shares the budget: overlapping runs make both see 429s, and both retry, so this
degrades rather than breaks.

Never print, log, or commit token values. `.env.local` and `.strava-token.json` are
gitignored from the first commit.

**The callback domain is the user's, not ours.** Strava permits exactly one Authorization
Callback Domain per application, and most people's is already spoken for -- a CLI tool that set
it to `localhost`, another project, an old experiment. Demanding they change it breaks whatever
depended on it, and would make any future domain move a migration event for every existing user.

We do not demand it. Strava validates the redirect **only** when issuing the authorization code;
the token exchange sends `client_id`, `client_secret`, `grant_type` and `code`, and never a
redirect URI at all (`packages/strava/src/auth.ts`). So the redirect only has to land somewhere
the user can read a URL -- it does not have to land on us. The user tells us the domain their app
already has, and:

- if it matches this host, the redirect is handled automatically and they see nothing unusual;
- otherwise Strava opens in a separate tab, the redirect lands on their own domain, and they
  paste the resulting address back. `completeFromPastedUrl` extracts the code and exchanges it
  directly.

`localhost` is the recommended value and the default, because nothing is listening there: the
browser fails to connect, and the authorization code is never transmitted to any server at all.
Steering people to it is a real security property, not a convenience -- a callback domain
pointing at a site the user does not control would put the code in that site's request logs.

**The public build shares nothing.** Every visitor registers their own Strava application and
holds their own credentials in their own browser. This is not a convenience: Strava counts
rate limits *per application*, so one shared registration would run dry after a handful of
people and the ceiling would be permanent. Per-visitor credentials remove the ceiling
entirely, and mean this project holds no Strava relationship and nobody else's secrets. The
cost, accepted deliberately, is that the API route requires a paid Strava subscription, since
June 2026 a condition of holding API credentials at all. The landing page says so before the
connect button rather than at step seven.

### 4.3 Sync

`npm run sync`:

1. Refresh the access token (persist the rotated refresh token immediately — every time,
   before anything else can fail).
2. Page `GET /athlete/activities` at `per_page=200` with 300 ms pacing, using `after=` the
   last-seen start time on subsequent runs. Write `data/summaries.json`.
3. For every activity that is eligible (see `docs/algorithm.md` section 3 for the exclusion
   rules) and does not already have a stream file, fetch
   `GET /activities/{id}/streams?keys=latlng,time,altitude&key_by_type=true` and write
   `data/streams/{id}.json.gz`. The response wraps each stream in an object; sync extracts
   the `.data` arrays into the flattened cache format (see `docs/data-pipeline.md` section 3.2).
4. Track progress in `data/sync-state.json` after every activity so an interrupted run
   resumes exactly where it stopped.
5. On HTTP 429, respect `Retry-After` and the `X-ReadRateLimit-Usage` / `X-ReadRateLimit-Limit`
   headers, sleeping until the next 15-minute window. Print a clear ETA. Never crash on a
   rate limit; a full backfill is expected to take hours and to be run repeatedly.

Backfill arithmetic at the upgraded limit: one stream request per activity, 200 reads per
15-minute window, so 2,000 activities is roughly 2.5 hours of wall clock — but that consumes
essentially the entire 2,000/day read cap once summary paging (about 10 extra reads) is
counted. Roughly 1,990 activities fit in a single day; above that the daily cap binds, and the
script must detect it and tell the user to resume tomorrow.

Escape hatch worth knowing but **not** part of the spec'd path: Strava's account-level bulk
export (Settings > My Account > Download your account) delivers the entire history as
FIT/GPX/TCX files with no rate limit. If backfill proves painful, importing that ZIP is a
one-command alternative. Do not build it unless asked.

### 4.4 Artifacts

`npm run build` reads `data/`, runs `packages/ledger`, and writes binary artifacts to
`app/public/artifacts/`. Exact byte layouts are in `docs/data-pipeline.md` section 5. The
manifest carries both a `formatVersion` and a hash of the algorithm parameters, and the app
treats them differently: a `formatVersion` mismatch means the binary blocks are unreadable and
the app shows the setup card, while a `paramsHash` mismatch is only a staleness warning and
the app still renders. See `docs/data-pipeline.md` section 6 step 1.

### 4.6 The publish deployment

A second, optional deployment that serves **the owner's own map, read only, to the public**. It
is a separate Vercel project (`groundcover-spencer`) deployed from a staged tree at
`.local/publish/`, never from this repo directly -- one repo holds one `vercel.json`, and the two
deployments need opposite ones. The BYO deployment allows Strava in `connect-src` and has no
functions; this one forbids Strava, allows the blob origin, and declares a cron.

Everything runs in the cloud. `api/refresh` wakes daily, pages what is new, fetches those
streams, rebuilds the whole ledger and republishes. Nothing depends on the owner's laptop being
awake, which is the entire point of the design.

**Storage is two blob stores, and the split is load-bearing.** Vercel Blob sets access per
*store*, not per object, and a store created from the CLI is public. So:

| store | access | holds |
|---|---|---|
| `groundcover-public` | public | built artifacts, `current.json` |
| `groundcover-private` | **private** | the rotating refresh token, summaries, the raw GPS corpus |

The private store must be created from the dashboard; the CLI cannot make one. Putting the
stream corpus or the token in a public store would protect one person's home address with
nothing but an unguessable URL.

The corpus is sharded by calendar year (`streams/<year>.pack`, see `scripts/publish/pack.ts`).
A full rebuild has to read every stream, and reading 1,300 objects would spend a minute of the
300 s function budget on round trips alone, against a 1,200 ops/minute ceiling. Eight reads
does not. The rebuild itself measures 5.9 s at 109 MB peak, so I/O is the only real constraint.

**The refresh token moves to the cloud and cannot be in two places.** Strava rotates it on every
refresh (section 4.2), so once seeded, the cloud owns it and `npm run sync` on the laptop stops
working. That is the intended end state, not a regression.

**The published map is truncated to 2023-01-01 and later.** The cutoff is `MIN_START_TS` in
`scripts/publish/refresh.ts`, deliberately not a `packages/ledger` parameter: it must not touch
`npm run build:ledger` or the BYO deployment, both of which stay whole-history. Pre-cutoff
activities are dropped outright rather than kept as prior ground, so ground first covered before
2023 counts as virgin the next time it is covered. The pointer records the cutoff it was built
with, so changing it republishes on the next run rather than waiting for a day with new
activities.

Artifacts are published under `builds/<buildId>/` and are immutable, so they cache for a month;
only the small `current.json` pointer is overwritten, and it alone carries a short TTL. The
previous build is deleted only after the pointer flip, so a reader mid-fetch is never orphaned.

---

## 5. The algorithm, in one page

Complete specification in `docs/algorithm.md`. The summary, so this document stands alone:

Every activity is resampled to a point every 8 metres. Points are processed in strict
chronological order across the whole history. The tool maintains one append-only table of
**sites** — accepted representative points, each with a position, a full direction of travel
(stored over 360 degrees but compared modulo 180 when matching, so opposite travel along the
same road matches), an altitude, a credit length, and the timestamp it was first covered.

For each resampled point, look up nearby sites whose direction of travel is compatible
(within 45 degrees):

- A compatible site within **20 m** means this is ground you have covered before. Label the
  point REPEAT. No new mileage.
- No compatible site within **30 m** means this is genuinely new ground. Label the point NEW
  and mint a site immediately, so that later points in the *same* activity can match it (this
  is what makes an out-and-back count once and 25 laps of a track count as 400 m).
- In between — 20 to 30 m — is a deliberate dead zone. Label the point AMBIGUOUS: no new
  mileage and no new site, but attach a visit to the nearest compatible site so the pass
  still registers on the map and in the distinct-ground number.

That hysteresis band is the single most important design element. It is what stops years of
GPS jitter along a familiar road from slowly accreting phantom new mileage: to earn credit,
a point must be *clearly* separated from everything you have covered, not merely at the edge
of the noise.

Unique mileage is then just the sum of the credit lengths of all minted sites. There is no
rasterization, so there is no cell-diagonal bias and no corner-clipping error.

Around that core sit the preprocessing steps that make it survive real GPS data: excluding
virtual and trainer activities, splitting the track wherever a gap or teleport occurs so a
dropout can never paint coverage, collapsing stationary jitter to a single point, and
discarding NEW runs shorter than 24 m so that a short multipath burst cannot mint permanent
phantom ground.

Known honest limitations, which the UI must not paper over:

- Paths less than ~20 m apart merge (a separated bike path beside a road counts as the road).
- Switchback legs 10-20 m apart merge unless the activity has barometric altitude. This is a
  genuine failure of any geometry-only method.
- Roads 20-30 m apart fall in the dead zone and earn nothing; between 30 and about 40 m under
  urban noise they earn partial, permanent credit. Full credit resumes past roughly 40-45 m.
- Genuinely new fragments shorter than 24 m are never credited.
- Small closed loops — cul-de-sac bulbs and park loops under about 100 m around — are only
  partially credited.
- Excluded activities (trainer, manual, virtual, no GPS) are absent from every number,
  including "total logged", so annual totals will not match Strava's.

Every one of these is bounded, deterministic, and documented in the app's own "How this is
calculated" panel.

---

## 6. User interface

### 6.1 Layout

**Persistent chrome is docked and never overlaps the map.** Only transient, user-summoned
surfaces are allowed over it: the site popup, the hover tooltip, the drag-zoom rectangle, the
sync ribbon.

That is not a stylistic preference. Every automatic fit pads by one symmetric `FIT_PAD` and has
no idea what is drawn on top of the map, so anything floating over it silently eats part of what
was framed — and a shared link (6.8) is a promise about exactly that. Panels used to float in
the corners, covering 222–302 px on the left and 280 px on the right against a fit that allowed
80 px, so what a link framed and what its recipient saw were routinely different. Docking makes
the map's own grid cell the visible rectangle, which makes the promise true by construction
rather than by a table of per-side insets that has to track every panel width forever.

The shell is a CSS grid with two layouts.

```
desktop (> 700px)                          phone (<= 700px)
+--------+---------------------------+     +-----------------------+
| search |                           |     |                       |
| filters|                           |     |          MAP          |
| mode   |            MAP            |     |                       |
| stats  |     (nothing over it)     |     +-----------------------+
| legend |                           |     | >  ===== scrubber === |
+--------+---------------------------+     +-----------------------+
| >  ======== scrubber ============= |     | ======= handle ====== |
+------------------------------------+     | stats / filters / ... |
                                           +-----------------------+
```

- **Rail** (`--rail-w`, 302 px): search, filters, mode, legend, stats, then account or the
  published footer pinned to the bottom. It widens to 560 px to hold the charts, which are
  docked rather than floated for the same reason as everything else — the drawer was the one
  surface large enough to bury the map completely.
- **Transport**: the scrubber, full width, always visible at every sheet position.
- **Phone**: the rail becomes a sheet with three stops — peek (the grab handle alone), half,
  full. It takes a grid row rather than floating, so the map's cell is still exactly what the
  viewer can see at any stop and fits need no mobile-specific code. Full stops at 55% of the
  viewport: a sheet that can cover the map turns the thing you came for into something you have
  to dismiss the UI to see. The year chips scroll sideways instead of wrapping, which used to
  double the transport's height on the screens with the least to spare.

Because the map is a grid cell rather than the window, it changes size without the window
doing anything, and MapLibre only watches the window: `MapView` carries a `ResizeObserver` that
resizes the map, re-syncs the deck camera, and **re-frames the last requested extent** — a plain
`resize()` keeps centre and zoom, which silently rescopes what a fit promised. The framing is
held until the viewer moves the map themselves.

Panel behavior:

- Filters and stats are collapsible to a title bar.
- Touch: rotation and pitch are disabled (an accidental twist otherwise widens the viewport
  filter), the pick radius grows on coarse pointers, drags use pointer capture and handle
  `pointercancel`, and the hover tooltip is suppressed for touch since a tap already opens the
  fuller popup.

### 6.2 Design tokens

Dark UI throughout — the map is dark and floating panels must not glare. Define these once
in `app/src/theme.css` as custom properties and reference them by role.

```css
:root {
  --map-surface:      #1b1f27;  /* the dark basemap's background; the chart surface for validation */
  --panel-bg:         rgba(20, 23, 30, 0.82);
  --panel-border:     rgba(255, 255, 255, 0.10);
  --text-primary:     #ffffff;
  --text-secondary:   #c3c2b7;
  --text-muted:       #8a8a80;

  /* Exploration mode: reserved accent for the frontier + a single-hue ordinal ramp for depth */
  --frontier:         #eda100;  /* exactly 1 visit */
  --repeat-1:         #256abf;  /* 2-4 visits   */
  --repeat-2:         #5598e7;  /* 5-9 visits   */
  --repeat-3:         #9ec5f4;  /* 10+ visits   */
  --ambiguous:        #4a4a52;  /* deliberately recessive; used only by the active-track layer */

  /* Heatmap mode: the same hue as a five-step ordinal ramp, no frontier accent */
  --heat-1:           #256abf;  /* 1 visit      */
  --heat-2:           #3987e5;  /* 2-4 visits   */
  --heat-3:           #6da7ec;  /* 5-9 visits   */
  --heat-4:           #9ec5f4;  /* 10-24 visits */
  --heat-5:           #cde2fb;  /* 25+ visits   */

  /* Charts: categorical slots, capped at 3 + Other */
  --series-1:         #3987e5;
  --series-2:         #d95926;
  --series-3:         #199e70;
}
```

These are not arbitrary. Both blue ramps were validated as ordinal ramps against the `#12141a`
map surface: monotone lightness, all adjacent lightness gaps at or above 0.06, single hue (2-3
degree spread), and the dimmest step clearing 3:1 contrast at 3.06:1 against the `#1b1f27` surface. (That
surface was lightened from `#12141a`, which read as near-black; the ramp was re-validated
against the new value rather than assumed to still hold. MapLibre's canvas additionally carries
a `brightness(1.42)` filter in dark mode to lift the basemap's own blacks -- safe because
deck.gl draws the coverage geometry to a separate canvas above it, so nothing in the validated
palette is touched by that filter.) The gold frontier accent
separates from every ramp step by CVD delta-E 24 to 35 (OKLab x100, target 8 or more), so the
frontier stays unmistakable under protanopia and deuteranopia. The chart categorical trio
passes all-pairs CVD and normal-vision floors in both light and dark.

**Light mode is a second selected palette, not an inversion.** On a dark surface brighter means
more, so the repeat ramp climbs toward white; on a light surface that reads backwards, so it
descends toward navy instead and every step was re-chosen rather than flipped.

```css
:root[data-theme='light'] {
  --map-surface:      #f4f4f1;
  --frontier:         #c07a00;  /* exactly 1 visit */
  --repeat-1:         #5b52e8;  /* 2-4 visits   */
  --repeat-2:         #3822a0;  /* 5-9 visits   */
  --repeat-3:         #1c0f5e;  /* 10+ visits   */

  --heat-1:           #5b52e8;  /* 1 visit      */
  --heat-2:           #4a34c9;  /* 2-4 visits   */
  --heat-3:           #3822a0;  /* 5-9 visits   */
  --heat-4:           #261577;  /* 10-24 visits */
  --heat-5:           #170a4d;  /* 25+ visits   */
}
```

**The light ramp is indigo, not blue, and the reason is the basemap.** The blue it replaced was
selected against its own surface and passed every criterion above — and still read as a river.
Two things the original criteria did not measure:

1. **Hairline width.** Coverage drew at `widthMinPixels: 1.2`, so at most zooms a line was
   sub-pixel and antialiasing blended it toward the surface. `#4a86cf` is a confident blue;
   `#4a86cf` as a hairline is `#8eb2dd`, a pale blue-grey — 1.99:1 against the surface, which is
   the measurement behind "hard to see". Every water and contrast check now runs on the colour
   as painted, at the mode's own opacity and the current minimum width, because that is the
   colour the eye compares. The width floor was raised at the same time; the two fixes are the
   same fix.
2. **The basemap's own palette.** Positron draws water in `#c2c8ca`/`#d4dadc`. The old ramp's
   hairline sat 10.2 from it, in the same hue family. The rule is now a distance *and* a
   40-degree hue-family separation, since a thin line is read by hue long before anyone measures
   a distance.

The indigo clears both: hairline 2.47:1, water 17.7 (13.5 under CVD), 109 degrees off the water
hue, and 25.5 from the gold frontier. Water *labels* (`#495e91`, `#7a96a0`) are deliberately not
part of the constraint — they are haloed text a few hundred pixels a screen, and holding a whole
ramp away from them is what pinned the old palette into blue in the first place.

Validated the same way, against `#f4f4f1`: both ramps monotone with adjacent lightness gaps at
or above 0.06, single hue, and every step clearing 3:1 (4.99:1 at the pale end). The frontier
accent had to change too: `#eda100` sits at 1.9:1 on a light map, a hairline nobody would see.
`#c07a00` clears 3:1 and separates from every step of the light ramp by CVD delta-E 25.5. The
categorical chart trio is the one group that needs no second set -- it passes all-pairs CVD and
the normal-vision floor on both surfaces.

**`npm run palette` is the checker**, and it is in the repository now
(`scripts/palette-check.ts`) rather than being a tool someone once ran elsewhere. It re-derives
every number in this section from `app/src/lib/theme.ts`, so "re-validate rather than eyeballing"
is an instruction that can actually be followed; `npm run palette -- search` ranks candidate hues
when a constraint changes, and `-- explain '#hex,#hex'` scores one candidate. Known deviations
are named in an `ALLOWANCES` table with their reason rather than hidden by loosening a
threshold: the dark ramps' recessive step is a 1.90:1 hairline, left alone because that step's
job is to recede and no one has reported it (`#256abf` -> `#3480da` would clear the bar at
2.31:1 if it ever matters).

The basemap changes with the surface: OpenFreeMap `dark` and `positron` respectively. This is
safe to swap bluntly because deck.gl draws on its own canvas rather than as a layer inside
MapLibre's style, so `setStyle()` cannot take the coverage geometry with it.

The theme is **not** carried in the URL hash. The hash is for what you are looking at; a shared
link should show the recipient their own preferred surface, not impose the sender's.

**Time-lapse reveals ground progressively.** `mintTs` on a site is the moment that ground was
first covered, recorded per resampled sample rather than per activity. While playback is
running the renderer hides sites whose `mintTs` is later than the window's end, so a route draws
itself along its path instead of appearing whole. Outside playback the gate is off: a static
selection means the activities in it, entire, which is what the stats count and what the
documented window semantics say. Artifacts built before per-sample times were recorded carry the
activity's start on every site, so they all clear the gate together and playback degrades to the
older pop-in behaviour rather than breaking.

If any of these values change, re-run the validator rather than eyeballing the result.

Rules that follow from this and must be honored:

- The frontier color is **reserved**. Never reuse gold for a chart series, a button, or a
  hover state.
- The repeat ramp is one hue. Do not insert a teal, green, or red step "for contrast" —
  that breaks the sequential encoding.
- On a dark surface, brighter means more. Higher visit counts get brighter steps, so
  well-worn ground reads as glowing and the frontier reads as a distinct color rather than
  a distinct brightness.
- Legend is always present. Color never carries meaning alone: the legend shows the ramp and
  its ends, and hover reports exact counts.
- **The repeat ramp is continuous and rescaled per query**, not banded. Fixed bands ("5-9") say
  nothing about anybody's history, and a fixed scale wastes most of the ramp on a window whose
  repeats never exceed three. It is scaled to the 98th percentile of visible counts rather than
  the maximum: one much-loved doorstep reaching a hundred visits would otherwise squeeze the
  whole history into the first slice. The top of the scale therefore reads "at least this many".
- **The frontier stays a reserved colour rather than the ramp's first stop.** A gold-to-blue ramp
  cannot be monotone in lightness on a dark surface -- gold sits at L 0.76, near the top of the
  blue range, so hue and magnitude fight -- and a ramp that cannot be read by brightness is not
  a ramp. Validated: the continuous ends are monotone, single-hue (3 degrees dark, 5 light), and
  clear 3:1 against their surface (3.06:1 dark, 3.40:1 light). The adjacent-lightness-gap rule
  is deliberately not applied, since it exists to keep discrete bands apart and a gradient has
  none.
- Text wears text tokens, never a data color.

### 6.3 Map layers

**The basemap has two providers, tried in order** (`BASEMAP_STYLES`, `app/src/lib/theme.ts`):
OpenFreeMap first, CARTO's Positron / Dark Matter second. Both are free and key-less, and both
are Positron-family so the palette in 6.2 holds either way. It is the one part of this app that
depends on somebody else's server staying up, and when that server is down the map becomes a
flat field with routes floating on it — which reads as "this is broken" rather than "the tiles
are late".

`MapView` walks the list on two distinct failures, because only one of them announces itself:
the style request failing (matched on the **failed request's URL**, never on error text — a
substring test for "style" also catches the relief layer's tile errors and MapLibre's own
"Style is not done loading", which the handler's own `setStyle` provokes), and a style that
loads but never loads a source, which is caught by a watchdog. The watchdog waits for a real
`sourcedata` event rather than `isStyleLoaded()`, and stands down while the tab is hidden:
MapLibre loads tiles from its render loop, so a backgrounded tab legitimately loads nothing and
must not be mistaken for a dead provider. The blank background remains, as the last resort.

Both deployments' CSPs list both hosts in `connect-src`; they have to be kept in step with the
list (`vercel.json`, `scripts/publish/stage.ts`).


Basemap: MapLibre GL JS with the OpenFreeMap Dark style
(`https://tiles.openfreemap.org/styles/dark`). Free, unlimited, no API key. If it fails to
load, fall back to a flat `--map-surface` background and show a small non-blocking notice —
the coverage layer is the point, the basemap is context.

Coverage layer (deck.gl `LineLayer`, added via `MapboxOverlay`): one short oriented segment
per site, centered on the site position, oriented along its bearing, with length equal to
the resample spacing. Roughly a million segments at 8 m each reconstruct the covered network
with no visible gaps. This layer *is* the heatmap, and because it draws sites rather than raw
tracks, what you see is exactly what the mileage numbers count.

- Positions are computed once at artifact load into `Float32Array`s and never change.
- Color is a `Uint8Array` of RGBA written by the query worker on every filter change. Pass
  the same position arrays by reference so deck.gl re-uploads only the color buffer.
- `widthUnits: 'meters'`, `getWidth: 7`, `widthMinPixels: 2.4`, `widthMaxPixels: 8`. The floor
  was 1.2, which is a hairline: antialiasing blends a sub-pixel line toward whatever is under
  it, so the colour on screen was most of the way back to the basemap and coverage read as one
  of the basemap's own thin features. 2.4 is still a fine line at city zoom and puts enough
  pixels down for the colour to be the colour.
- Sites with `visitCount === 0` under the current filter get alpha 0.
- In heatmap mode **on the dark surface**, enable additive blending
  (`parameters: { blend: true, blendFunc: [SRC_ALPHA, ONE] }`) so overlapping density
  accumulates into a glow. In exploration mode use normal alpha blending so the frontier
  color stays true.
- **Light mode never blends additively.** Adding light to a near-white map drives every overlap
  toward white, so the busiest ground came out the faintest -- the exact inverse of what the
  mode encodes. Light composites normally and carries the density in opacity instead.

Active-track layer (deck.gl `PathLayer`): during time-lapse playback, the single activity
currently being played is drawn on top in near-white at higher width, so you can see the
run that is discovering the ground. Also used when an activity is selected from the stats
drawer. Loads `tracks.bin` lazily on first need. This is the only layer with access to
per-sample labels, so it is the only consumer of `--ambiguous`: points flagged AMBIGUOUS or
NONE draw in that color while NEW and REPEAT stay near-white. The coverage layer cannot use
it, because `touches.bin` carries no labels.

Picking: hovering the coverage layer shows a tooltip with the site's first-covered date,
the activity that first covered it, and the visit count under the current filter.

### 6.4 Controls

**Sport filter.** Multi-select checkboxes over sport *groups*, not raw Strava sport types:

| Group | Strava `sport_type` values |
|---|---|
| Foot | Run, TrailRun, Walk, Hike, Snowshoe, Wheelchair |
| Ride | Ride, GravelRide, MountainBikeRide, EBikeRide, Handcycle, Velomobile |
| Ski | NordicSki, AlpineSki, BackcountrySki, RollerSki |
| Water | Kayaking, Canoeing, Rowing, StandUpPaddling, Surfing, Swim |
| Other | anything else with usable GPS |

Default: all groups selected. Each label shows the count of *included* activities in that
group — excluded trainer, manual, virtual, and GPS-less activities are absent from the
artifacts entirely and are counted nowhere.

**Mode toggle.** Exploration (default) or Heatmap, both driven by the same filtered visit
count per site:

| Visits | Exploration | alpha | Heatmap | alpha |
|---|---|---|---|---|
| 0 | hidden | 0 | hidden | 0 |
| 1 | `--frontier` | 255 | `--heat-1` | 90 dark / 190 light |
| 2-4 | `--repeat-1` | 255 | `--heat-2` | 90 dark / 190 light |
| 5-9 | `--repeat-2` | 255 | `--heat-3` | 90 dark / 190 light |
| 10-24 | `--repeat-3` | 255 | `--heat-4` | 90 dark / 190 light |
| 25+ | `--repeat-3` | 255 | `--heat-5` | 90 dark / 190 light |

Alpha is part of the encoding, not a detail. Exploration mode uses normal alpha blending at
full opacity so the band colors read true. Heatmap mode uses additive blending, where alpha
controls how fast overlapping geometry saturates — at 255 every crossing clips to white within
two or three overlaps and the five-step ramp is destroyed. 90 is the dark value. Light mode
composites normally rather than additively, so nothing saturates toward white and 90 would
simply be faint: it uses 190. Both live in `MODE_ALPHA` (`app/src/lib/palette.ts`).

The two modes share the 2-4 / 5-9 breakpoints so the legend stays learnable, but they diverge
above 10: exploration has four bands (its top band is 10+) while heatmap has five (10-24 and
25+). `Legend.tsx` must render a different row set per mode — it cannot be a static list.
Exploration labels: frontier / familiar / known / worn in. Heatmap labels are the visit ranges
themselves.

**Timeline scrubber.** Along the bottom:

- A histogram of activity distance per month across the full history, drawn in
  `--text-muted` at low opacity, which doubles as the brush track. It **responds to the sport
  filter but not to the time window** — it is the map of the territory you are scrubbing
  through, so it must show the whole history while reflecting which sports are in play.
- A two-handle brush. Drag either handle, or drag the middle to slide the window.
- Preset chips: All time, Last 12 months, and one per calendar year.
- Readouts of the exact window start and end dates.
- Transport controls: play/pause, speed (0.5x, 1x, 2x, 4x), and a window-mode select of
  Expanding (t0 pinned at history start, t1 advances) or Sliding (fixed-width window moves).

At 1x, playback replays the **whole history in about 45 seconds**, whatever it spans, pro-rated
per frame by elapsed wall-clock milliseconds so the rate is independent of frame rate. A
normalised rate rather than a fixed one keeps playback watchable whether the history covers one
year or ten. The other presets scale it. In Expanding mode the rate applies to `t1`; in Sliding
mode it applies to the fixed-width window's position. Reaching the end pauses playback with the
window at its final position.

**Pressing play while the window is already at the end rewinds and replays from the start.**
The default view is all-time, so without this the first frame runs past the end, playback stops
instantly, and the button appears to do nothing at all. Per-frame elapsed time is also clamped
(0.25 s) so returning to a backgrounded tab resumes rather than jumping.

Calendar bucketing — the monthly histogram and the per-period bar chart — derives from each
activity's `startDateLocal` (Strava's `start_date_local`), not from the viewer's timezone. A
run at 11 pm on December 31 belongs to the year the athlete lived it, and a bookmarked URL
means the same thing on any machine.

Filtering, however, is always a `[t0, t1]` window over UTC `startTs` — that is the only thing
the fold understands. These two facts cannot both hold for the preset chips, because for an
athlete who travels there is no single UTC window that exactly reproduces a local-calendar
year. The chips resolve it explicitly: **a year chip sets `t0` and `t1` to the UTC timestamps
of the first and last activity whose `startDateLocal` falls in that year.** The window then
contains exactly that year's activities by the athlete's own calendar, and it is still an
ordinary UTC window that the fold and the scrubber handles agree on. Buckets and windows stay
consistent because both are ultimately defined by the same per-activity data.

**Viewport filter.** A "Limit stats to map view" checkbox in the stats card. Off by default,
so panning the map never silently changes your lifetime numbers. When on, the stats card
shows a badge and the map draws a hairline inset border to make the constraint visible.

Only the two ground numbers can be clipped to a viewport — a site has a position, but an
activity's recorded distance does not. So when the filter is on, distinct ground and new ground
are viewport-limited while **total logged and repeat ratio are hidden entirely**, replaced by
"n activities intersect this view". Showing a clipped numerator over an unclipped denominator
would be a meaningless ratio, and hiding it is more honest than inventing an approximation.

**Units.** A mi/km toggle in the stats card footer. Default miles. Persisted in the URL hash.

### 6.5 Stats drawer

"Stats and charts >" in the stats card opens a larger panel over the left half of the
screen. All charts honor the current filters and update with them. All charts are
hand-rolled SVG — no chart library.

Chart rules, non-negotiable:

1. **Cumulative coverage over time.** Two lines on one axis: cumulative new ground (blue,
   `--series-1`) and cumulative total logged distance (orange, `--series-2`), both in the
   selected unit. Legend present; both lines directly labeled at their right end. Crosshair
   plus tooltip on hover. Never a second y-axis.
2. **New ground per period.** Bar chart, one series, `--series-1`, bucketed by month when
   the window is under three years and by year otherwise. 2 px gaps between bars, 4 px
   rounded tops, baseline anchored at zero. Per-bar hover tooltip.
3. **Biggest discoveries.** Table of the top 20 activities by new ground, with a bar-in-cell
   for the new-ground column: date, name, sport, new ground, distance, percent new. Clicking
   a row draws that activity on the map and flies to its bounds.

   The `newGroundM` in `activities.json` is a **global, unfiltered** figure: the ground that
   activity minted across the whole history with no sport filter. That makes it correct only
   when no sport filter is applied. When one is, the table would silently contradict the
   headline number, so instead the worker recomputes per-activity new ground under the current
   sport filter, as a third pass: walk the selected activities in chronological order, and for
   each touched site whose `firstTsByGroup` minimum over the selected groups equals that
   activity's `startTs`, add its credit. Cost is the same order as pass 1. The time window is
   *not* applied here — the table ranks discoveries within the selected window, so it iterates
   only the windowed activities anyway.
4. **By sport.** Small table (not a pie): sport group, distinct ground, new ground, total
   logged, repeat ratio. Colored chip beside each group name using slots 1-3, with a fourth
   and beyond folded into "Other" in `--text-muted`.

   These figures cannot be sliced out of the main query result — ground covered by both a run
   and a ride belongs to both rows, so per-group numbers do not sum to the total and any
   post-filtering of a single result is wrong. Instead the worker runs the **same fold and
   scan once per selected group**, each restricted to that one group, and returns an array of
   per-group results alongside the combined one. With at most five groups that is five extra
   linear passes, tens of milliseconds, and it only runs while the drawer is open.

   The table must therefore state that its rows overlap: a header note reading "ground covered
   by more than one sport appears in every row that covers it, so the rows do not sum to the
   total." Without that, the numbers look like an arithmetic error.

Every chart offers a "table" toggle that renders the same numbers as an HTML table. That is
the standard accessibility relief, and it is required here regardless of contrast — the chart
palette clears 3:1, but a table is the only form that works with a screen reader.

### 6.6 Application states

| State | Behavior |
|---|---|
| No artifacts present, or `formatVersion` mismatch | Full-screen setup card with the four commands from section 2 and a link to `docs/data-pipeline.md`. Not an error. A format mismatch means the binaries cannot be parsed at all, so the app must not attempt to render stale data. |
| `paramsHash` mismatch | Banner: "Artifacts were built with different algorithm parameters. Run `npm run build`." App still renders — the data is readable, just stale. |
| Artifacts loading | Skeleton panels and a determinate progress bar driven by fetch progress. Typical payload is 60-90 MB, so this is seconds. |
| Worker computing | Stat numbers get a subtle pulse. Never blank them; never block the map. |
| Empty selection | Zeros with the copy "No activities in this selection", not "0.0 mi". |
| Basemap failed | Flat background, small dismissible notice. Coverage layer still renders. |

### 6.7 "How this is calculated"

A link in the stats card footer opens a modal explaining, in plain language: the two mileage
numbers and how they differ, the ~20 m matching tolerance, and an honest list of the
limitations from section 5 — including that excluded activities are missing from "total
logged", so the numbers here will not match Strava's yearly totals. Users will find edge
cases; the tool should have already told them about these. Do not hide them.

### 6.8 URL state

The selection serializes into the URL hash so a view is reloadable, bookmarkable and
shareable: window start and end (`t0`/`t1`), selected sport groups, map mode, viewport-filter
flag, units, and the flag options. Read on mount, write on change (debounced 250 ms, using
`replaceState` so the back button is not spammed), and re-read on `hashchange` so pasting a
link into a tab that is already open moves the map rather than just the address.

**The camera is not in the hash by default, and that is deliberate.** It used to be, rewritten
on every pan as `map=lng,lat,zoom`, which meant every link anyone copied out of the address bar
silently pinned the sharer's camera onto the recipient's differently-shaped screen. So:

| | where | effect |
|---|---|---|
| no camera | the default | the map fits the shared time frame — the ground the animation covers |
| `b=minLng,minLat,maxLng,maxLat` | written only by the share panel, on request | opens at exactly that extent |
| `map=lng,lat,zoom` | legacy, read only | honoured so links shared before `b=` still land where they say |
| current position | `sessionStorage` | survives a reload of this tab without travelling in a link |

An extent rather than a centre and zoom, because an extent is what survives being opened
somewhere else: the same centre and zoom frames more ground on a wide monitor than on a phone,
so the one thing the sharer was pointing at is the thing a centre fails to preserve.

`t0`/`t1` are unix seconds when written, and either seconds or an ISO date when read: a shared
window is exact to the second, and a hand-composed one can say `t0=2023-01-01`. A bare date is
midnight UTC, matching `startTs`. Everything parsed out of the hash is validated and clamped to
the data the build actually holds — it is editable text arriving from someone else's paste, and
one `NaN` reaching `t0` would blank the map with no error anywhere.

---

## 7. Performance budgets

Fail the milestone if these are not met on the target machine (an M-series Mac, Chrome, at the
reference scale of 3,000 activities and roughly 1M sites; the budgets carry headroom to 1.4M).

| Operation | Budget |
|---|---|
| `npm run build` full ledger rebuild | < 30 s |
| Artifact load to first painted map | < 5 s |
| Filter change (sport, time window, mode) to repainted map | < 100 ms |
| Time-lapse playback | sustained 30 fps |
| Map pan/zoom | 60 fps |
| Resident browser memory | < 400 MB |

---

## 8. Testing

- `packages/ledger` is the only place correctness genuinely matters, and it is a pure
  function, so it carries the bulk of the tests. `docs/algorithm.md` section 10 specifies a
  synthetic track generator (10.1) and one test per adversarial case (10.2; the cases
  themselves are defined in section 9), each with asserted mileage bounds. **These tests are
  the spec.** If the implementation and the tests disagree, the tests win.
- `packages/strava` gets tests against recorded JSON fixtures (never live API calls in tests).
- The query worker gets tests over a small synthetic artifact set, asserting that the fold
  and scan produce the same numbers as a naive reference implementation.
- The app gets no component tests in v1. Verify visually with `npm run dev` plus the
  chrome-devtools MCP.
- CI (`.github/workflows/ci.yml`) runs `lint`, `typecheck`, `test`, and `npm -w app run build`
  on every push to `main` and every pull request. It does **not** run `build:ledger`, which
  needs the gitignored `data/` directory; the ledger is already fully exercised by `test`.
- The app's browser-facing modules read `sessionStorage` and `window.location` at import, so
  `app/src/**` runs under jsdom while everything else stays on the faster `node` environment.

---

## 9. Order of work

See `docs/build-plan.md` for the milestone-by-milestone plan with acceptance criteria. The
short version, and the reason for the order:

1. Scaffold.
2. Strava auth and sync — because everything downstream needs real data, and the backfill
   takes hours of wall clock that should start early and run in the background.
3. **The ledger package and its adversarial test suite** — the heart of the tool. Build it
   against synthetic tracks before it ever sees real data.
4. The build script and artifact format.
5. Map and static coverage rendering.
6. Query worker and filters.
7. Modes, legend, tooltips.
8. Time-lapse playback.
9. Stats drawer and charts.
10. Polish: URL state, units, "how this works" modal, the optional offset detector.
