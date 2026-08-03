# Build plan

Ordered milestones. Each is independently shippable and independently verifiable. Do not
start a milestone before its predecessor's acceptance criteria pass — with one deliberate
exception noted at M1, because the backfill takes hours of wall clock and should be running
in the background while later milestones are built.

Commit at each milestone boundary at minimum, with conventional commit messages, atomically,
straight to `main`. No PRs. No `Co-Authored-By` lines.

---

## M0 — Scaffold

**Build**

- `npm init` workspace root with workspaces `["packages/*", "app"]`.
- `packages/strava` and `packages/ledger` as TypeScript packages (`@um/strava`, `@um/ledger`),
  each with `src/`, `src/__tests__/`, and a `tsconfig.json` extending the root.
- `app/` via Vite React TypeScript template.
- Root `tsconfig.json` with project references; `eslint.config.js` (flat); `vitest` config.
- `.gitignore` covering `.env.local`, `.strava-token.json`, `data/`,
  `app/public/artifacts/`, `node_modules`, `dist`.
- Root `package.json` scripts:

  ```json
  {
    "auth":        "tsx scripts/auth.ts",
    "sync":        "tsx scripts/sync.ts",
    "build:ledger":"tsx scripts/build-ledger.ts",
    "stats":       "tsx scripts/stats.ts",
    "dev":         "npm -w app run dev",
    "build":       "npm run build:ledger && npm -w app run build",
    "preview":     "npm -w app run preview",
    "lint":        "eslint .",
    "typecheck":   "tsc --noEmit -b",
    "test":        "vitest --run"
  }
  ```

- `CLAUDE.md` per `docs/data-pipeline.md` section 7.

**Acceptance**: `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run dev` all
succeed on an empty project. `.gitignore` is in the first commit, before any credential file
can exist.

---

## M1 — Strava client, auth, and sync

**Build**

- `packages/strava`:
  - `auth.ts` — `mintAccessToken(creds)` returning `{ accessToken, expiresAt, rotated }`;
    caller persists rotations.
  - `client.ts` — stateless `fetch` wrapper. Parses `X-ReadRateLimit-Usage` and
    `X-ReadRateLimit-Limit`, throws a typed `RateLimitError` carrying `retryAfterMs` on 429,
    and a typed `StravaHttpError` otherwise. Never logs token values.
  - `crawl.ts` — `pageActivities({ after })` generator, `per_page=200`, 300 ms pacing.
  - `types.ts` — `zod` schemas for `SummaryActivity` and `StreamSet`; unknown keys logged,
    not fatal.
- `scripts/auth.ts` — the one-time OAuth flow from `docs/data-pipeline.md` section 2.
- `scripts/sync.ts` — the resumable crawl from section 3, writing `data/summaries.json`,
  `data/streams/{id}.json.gz`, and `data/sync-state.json` after every activity.

**Acceptance**

- `npm run auth` produces a valid `.strava-token.json`; neither it nor `.env.local` is
  tracked by git.
- `npm run sync` fetches summaries and begins fetching streams; killing it mid-run with
  Ctrl-C and restarting resumes without refetching anything already stored.
- A simulated 429 (unit test with a mocked fetch) causes a sleep and retry rather than a crash.
- Tests run against recorded JSON fixtures only — never the live API.

**Then start the backfill and leave it running.** M2 needs no real data.

---

## M2 — The ledger (the critical milestone)

This is where the tool's correctness lives. Everything else is presentation.

**Build**, strictly in this order:

1. `packages/ledger/src/geo.ts` — Mercator conversions, `groundDist`, bearing encode and the
   two angle differences. Unit-test these first; every later bug traces back here.
2. `packages/ledger/src/params.ts` — the frozen parameter object from `docs/algorithm.md`
   section 8, plus `PARAMS_HASH`, a **synchronous, dependency-free** hash of its canonical JSON
   serialization (keys sorted). Use a small inline non-cryptographic hash such as FNV-1a
   rendered as hex — `crypto.subtle.digest` is async and unusable here, and the package may not
   import `node:*` or third-party code. Collision resistance is irrelevant; this only needs to
   change when the parameters change.
3. `packages/ledger/src/__tests__/synth.ts` — the deterministic synthetic track generators
   from `docs/algorithm.md` section 10.1. Seeded PRNG, never `Math.random()`.
4. **Write the failing tests from section 10.2 now**, before the algorithm.
5. `preprocess.ts` — stage 1: exclusion, timestamp assembly, median filter, leg splitting,
   stationary collapse, resampling, credit assignment.
6. `match.ts` — the grid hash and the candidate query.
7. `ledger.ts` — Pass I including the wrap-repeat rule (4.3.1), the tombstone passes
   (short-run and U-turn; leave the offset detector for M9 behind its flag), Pass II,
   compaction, and the derived per-group first-visit arrays.
8. `artifacts.ts` — serialization to `ArrayBuffer`s plus the manifest object. No file I/O.

**Acceptance**

- Every test in `docs/algorithm.md` section 10.2 passes **except A9b**, which is deferred to
  M9 along with the offset detector it exercises. This includes the tests that assert
  documented *failures* (A6b switchbacks without altitude, A9c with the detector off). Those
  exist so a future change that alters the behavior fails loudly instead of silently. A9c is
  not deferred: with the detector unimplemented behind its flag, it passes in M2 and locks in
  the baseline behavior.
- The determinism test produces byte-identical output across two runs with shuffled input.
- `packages/ledger` imports nothing from `node:*` and no third-party runtime dependency.

**Common wrong turns to avoid here**

- Deferring site creation to a commit step after the matching pass. Sites must be minted
  eagerly, inside Pass I, and inserted into the grid immediately. Without that, a first-ever
  out-and-back double-counts and 25 laps of a track credit 10 km.
- Recording sample-to-site links during Pass I. Links are assigned in Pass II, after
  tombstoning, on purpose.
- Omitting the fold-back condition from the U-turn dedup pass (algorithm.md 5.3). Without it,
  the pass silently deletes real ground at every tight switchback turn. Test A1c exists
  specifically to catch this.
- Comparing altitude across activities. Same-activity only. Barometric altitude drifts tens
  of metres between days and cross-activity comparison mints a phantom copy of entire routes.
- Using `BigInt` or string keys in the grid hash.
- Reaching for h3-js, turf.js, or any geo library. The geometry needed is in `geo.ts`.

---

## M3 — Build script and artifacts

**Build**

- `scripts/build-ledger.ts` — read `data/`, sort activities, call the ledger, write
  `app/public/artifacts/`.
- `scripts/stats.ts` — print the smoke-check summary from `docs/algorithm.md` section 10.3.

**Acceptance**

- Runs to completion on the real (possibly partial) backfill.
- Completes in under 30 s at roughly 3,000 activities.
- `npm run stats` output passes every smoke check: unique mileage well below total, the
  chronologically first activity nearly 100 percent new, a repeated route contributing
  near-zero new ground after its first occurrence.
- A round-trip test reads the artifacts back and reproduces every **serialized** column exactly:
  site positions (to the stored centimetre), bearing, credit, mint timestamp, mint activity,
  the per-group first-visit arrays, and every touch list. Build-time-only fields (altitude,
  `mintS`, `alive`) are not serialized by design and are not compared.

---

## M4 — Map and static coverage rendering

**Build**

- `app/src/map/MapView.tsx` — MapLibre with the OpenFreeMap Dark style, a deck.gl
  `MapboxOverlay`, and a fallback flat background if the basemap fails.
- `app/src/worker/query.worker.ts` — artifact loading and derived render geometry only, per
  `docs/data-pipeline.md` section 6. No queries yet.
- `app/src/map/layers.ts` — the coverage `LineLayer` with binary attributes. There is no
  precomputed visit-count column in the artifacts, so at this milestone color every visible
  site with a single flat color and prove the geometry renders. Coloring by visit count
  arrives with the query worker in M5.
- `app/src/theme.css` — the design tokens from `SPEC.md` section 6.2, verbatim.
- Loading and empty states.

**Acceptance**

- The full history renders in a single flat color. Panning and zooming hold 60 fps.
- Load to first paint is under 5 s.
- With no artifacts present, the setup card appears instead of an error.
- Visual check against the real map: covered roads should look like roads, not a cloud. If
  they look like a cloud, the bearing or resampling is wrong — go back to M2.

---

## M5 — Query worker and filters

**Build**

- `query.worker.ts` gains the fold and scan from `SPEC.md` section 3.4, returning
  `{ slot, colors, distinctM, newM, totalM, activityCount }` per the message contract in
  `docs/data-pipeline.md` section 6 step 5, with `colors` transferred.

  When the viewport filter is on, `distinctM` and `newM` are viewport-limited, `activityCount`
  is the number of selected activities whose bbox intersects the viewport, and `totalM` is
  `null` (the field is typed `number | null` for exactly this) — the stats card hides total
  logged and repeat ratio in that mode (`SPEC.md` section 6.4). Do not substitute an unclipped
  total; a clipped numerator over an unclipped denominator is a meaningless ratio.
- The color buffer protocol: the worker keeps two color buffers and writes whichever is free,
  transferring it with the response tagged by `slot`. The main thread posts the buffer back
  (with a transfer list, echoing `slot`) after the deck.gl render that consumes it, not on
  receipt. Two buffers are needed precisely because a new query can start while the previous
  buffer is still awaiting its post-render release; playback never allocates.
- `app/src/worker/queryClient.ts` — typed request/response wrapper that coalesces
  in-flight requests (only the latest query matters).
- `app/src/state/store.ts` — zustand store holding the filter state.
- `panels/FilterPanel.tsx` — sport group checkboxes with per-group counts.
- `panels/Scrubber.tsx` — monthly distance histogram, two-handle brush, preset chips, date
  readouts. No playback transport yet.
- `panels/StatsCard.tsx` — both headline numbers with equal billing, plus total logged,
  repeat ratio, the "Limit stats to map view" checkbox, and a mi/km toggle.

**Acceptance**

- Any filter change repaints in under 100 ms, measured with the devtools performance panel.
- New ground never exceeds distinct ground, for every filter combination.
- Selecting a single sport group produces numbers computed as if only that group existed
  (a road first ridden and later run counts as new ground for the run when filtered to Foot).
- The viewport toggle changes the numbers and draws the hairline inset border.
- A worker unit test compares fold-and-scan output against a naive reference implementation
  over a small synthetic artifact set.

---

## M6 — Map modes, legend, tooltips

**Build**

- Exploration and heatmap color mapping in `layers.ts`, including the additive blend for
  heatmap mode.
- `panels/Legend.tsx`, always visible, labeling every band. The two modes have different band
  counts (four for exploration, five for heatmap), so the row set is per-mode, not static.
- deck.gl picking with a hover tooltip: first-covered date, the activity that first covered
  the ground, and the visit count under the current filter.

**Acceptance**

- Exploration mode is the default on first load.
- The frontier color is used nowhere else in the interface.
- Toggling modes repaints in under 100 ms and does not refetch anything.
- Hover over any covered ground yields a correct tooltip; hovering empty ground yields none.

---

## M7 — Time-lapse playback

**Build**

- Transport controls in the scrubber: play/pause, speed (0.5x, 1x, 2x, 4x), window mode
  (Expanding or Sliding).
- Playback loop driven by `requestAnimationFrame`, advancing the window at the rate defined in
  `SPEC.md` section 6.4 (one month of history per real second at 1x, pro-rated by elapsed
  wall-clock time) and issuing an incremental fold: add activities entering the window, and in
  Sliding mode also subtract those leaving it. See `SPEC.md` section 3.4.
- Lazy load of `tracks.bin` on first play; the currently-playing activity drawn on top in
  near-white via a `PathLayer`, respecting leg breaks.

**Acceptance**

- Playback sustains 30 fps over the full history, measured at 1x.
- Newly discovered ground visibly appears in the frontier color and cools into the repeat
  ramp as it is re-covered.
- Pausing leaves the window exactly where playback stopped, and the scrubber handles agree
  with it.
- Playing to the end and then scrubbing back yields the same numbers as scrubbing there
  directly — the incremental fold must not drift from the full fold. Test this explicitly.

---

## M8 — Stats drawer

**Build**

`panels/StatsDrawer.tsx` plus hand-rolled SVG chart primitives in `app/src/charts/`. The four
charts from `SPEC.md` section 6.5, honoring the current filters.

This milestone also adds worker work, not only UI: the `extras` block of the query response
(`docs/data-pipeline.md` section 6 step 5), computed only when the request sets `drawer: true`.
That covers the filtered per-activity new ground for chart 3, the per-bucket series for charts
1 and 2, and the per-group repeat of the fold and scan for chart 4. Build the worker side
first and verify it against the stats card totals before drawing anything.

Chart rules, from the data-visualization method and non-negotiable:

- One y-axis, ever. Never a second scale.
- A legend whenever two or more series are present; none for a single series (the title names
  it). Direct-label lines at their right end; never a number on every point.
- Sequential encoding uses one hue. Categorical uses slots 1 through 3 from `theme.css`, in
  fixed order, with a fourth and beyond folded into "Other" — do not generate new hues.
- Bars: 2 px gaps between them, 4 px rounded tops, baseline anchored at zero.
- Every chart ships a crosshair or per-mark hover tooltip, and a table toggle rendering the
  same numbers as HTML.
- Text wears text tokens, never a series color.

**Acceptance**

- Every chart updates with the filters and matches the stats card totals. In particular, the
  "biggest discoveries" new-ground column must sum consistently with the headline new-ground
  number under a sport filter, which is why it comes from the worker's third pass
  (`SPEC.md` section 6.5) rather than from `activities.json`'s unfiltered `newGroundM`.
- Clicking a row in "biggest discoveries" draws that activity and flies to its bounds.
- Table toggles render correct values.
- Open the drawer and look at it. The validator checks color, not layout: verify no label
  collisions, no overflow, and no horizontal page scroll.

---

## M9 — Polish

**Build**

- URL-hash state per `SPEC.md` section 6.8.
- The "How this is calculated" modal per section 6.7, including the honest limitation list.
- The offset detector from `docs/algorithm.md` section 5.4, behind `params.offsetDetector`.
  Test A9b now passes (it was the one M2 test deferred); confirm A9c still passes with the
  flag off.
- Artifact version-mismatch banner.
- Keyboard shortcuts: space to play/pause, left and right arrows to step the window, `E` and
  `H` to switch modes.

**Acceptance**

- Copy a URL, open it in a fresh tab, and land on an identical view.
- Enabling and disabling the offset detector changes the numbers in the direction the tests
  assert.
- Full pass: `npm run lint && npm run typecheck && npm run test && npm run build`.

---

## Verification harness

Throughout, prefer these over guessing:

- `npm run stats` after any ledger change. The smoke checks catch broken builds in seconds.
- `npm run dev` plus the chrome-devtools MCP for UI work: take a screenshot, read the console,
  and check the performance panel against the budgets in `SPEC.md` section 7.
- When a mileage number looks wrong, reach for a synthetic test that reproduces it before
  touching the algorithm. Every parameter in `docs/algorithm.md` section 8 has a
  justification; changing one without a failing test that motivates it is how this tool
  silently becomes wrong.

## If you get stuck

- **Unique mileage looks far too high** — check that sites are minted eagerly inside Pass I,
  and that the U-turn dedup pass runs. These are the two failures that inflate totals.
- **Unique mileage looks far too low** — check the bearing baseline (a too-short baseline
  makes bearings noisy and everything looks like a repeat) and check that the guard is being
  applied in Pass I but *not* in Pass II.
- **The map looks like a cloud rather than roads** — bearings or resampling are wrong.
- **Filter changes feel sluggish** — confirm the fold walks sorted touch lists and that the
  color buffer is transferred rather than copied. Do not add a spatial index at query time;
  the budget is met by linear passes.
