# Data pipeline

Strava credentials, sync, on-disk formats, and the exact byte layout of the artifacts the
web app consumes.

---

## 1. Strava application setup (manual, do this first)

### 1.1 Reuse the existing application

Strava allows one API application per account, and the account already has one — the
registration other tools on the same account share. unique-miles uses the same
`STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`, copied into its own gitignored `.env.local`.

Confirm the Authorization Callback Domain at <https://www.strava.com/settings/api> is
`localhost`; `npm run auth` redirects to `http://localhost:8721/callback` and Strava matches
on domain, so any port works. If the domain is set to something else, `npm run auth` fails at
the redirect and the domain must be changed (which is safe — it does not affect another tool,
whose OAuth also runs against localhost in development and against its Vercel domain in
production only through a separately configured callback).

Read limits are whatever the shared app is provisioned for. If it is still in Single Player
Mode (athlete capacity 1), the limits are 100 reads per 15 minutes and 1,000 per day; the
self-service upgrade to 10 athletes in the API Settings Dashboard doubles both. Applying that
upgrade is worthwhile and harmless to existing consumers.

### 1.2 Sharing one app: the refresh-token hazard

Because the registration is shared, unique-miles becomes another consumer of a credential the
another tool depends on. `an internal design note` documents the hazard: Strava rotates the refresh
token on every refresh, and several stores already hold copies (a server-side store under
`a shared key`, `another store`, `another store`, and the another consumer).

The rules that keep this safe, and they are not optional:

- unique-miles performs its **own** OAuth authorization and holds its **own** refresh token in
  its own `.strava-token.json`. It never reads or writes the another tool's token stores.
- unique-miles persists every rotation immediately, so its own token never goes stale.
- The backfill shares the app's rate-limit budget with another tool. Run large backfills when the
  another tool's sync is not running, and expect another tool to hit 429s if they overlap — both sides
  retry, so this degrades rather than breaks.

If a re-authorization ever does invalidate the another tool's refresh token, another tool has a documented
break-glass procedure: `DEL a shared key` plus `npm run seed:redis` in production, or refresh
`.env.local` and delete `.strava-token.json` locally.

### 1.3 Credential storage

`.env.local` at the repo root, gitignored from the very first commit:

```
STRAVA_CLIENT_ID=<numeric id>
STRAVA_CLIENT_SECRET=<secret>
```

`.strava-token.json` at the repo root, also gitignored, written by `npm run auth` and
rewritten by every token refresh:

```json
{ "refreshToken": "...", "accessToken": "...", "expiresAt": 1785790000, "athleteId": 12345 }
```

Rules, non-negotiable:

- Both files are in `.gitignore` before the first commit that could touch them.
- Never log, print, or include a token value in an error message. `another tool` logs its access
  token at debug level; do not copy that.
- The refresh token in `.env.local` is only a bootstrap seed if one is present at all;
  `.strava-token.json` is the source of truth once it exists.

---

## 2. Auth (`npm run auth`)

`scripts/auth.ts` runs the one-time authorization:

1. Start a local HTTP server on `http://localhost:8721`.
2. Print (and open) the authorize URL:

   ```
   https://www.strava.com/oauth/authorize
     ?client_id=<id>
     &redirect_uri=http://localhost:8721/callback
     &response_type=code
     &approval_prompt=force
     &scope=activity:read_all
   ```

   `activity:read_all` is required, not `activity:read`. Without it, activities marked
   "Only You" are silently missing and privacy-zone GPS data is trimmed — a personal
   coverage map would quietly be wrong.

3. On the callback, exchange the code:

   ```
   POST https://www.strava.com/oauth/token
     client_id, client_secret, code, grant_type=authorization_code
   ```

4. Write `.strava-token.json`, respond with a plain "Authorized, you can close this tab",
   and shut the server down.

Strava does not support PKCE, so the client secret is required for the exchange. That is
fine here because everything runs locally; it is also the reason a browser-only version of
this tool is impossible.

**Token refresh**, used by every subsequent script:

```
POST https://www.strava.com/oauth/token
  client_id, client_secret, refresh_token, grant_type=refresh_token
```

Access tokens live 6 hours. Every refresh returns a **new refresh token that replaces the
old one**. Persist the rotated token to `.strava-token.json` immediately on receipt, before
doing anything else that could throw. Losing a rotated token means re-running `npm run auth`.

---

## 3. Sync (`npm run sync`)

`scripts/sync.ts`, built on `packages/strava`.

### 3.1 Summaries

```
GET /athlete/activities?per_page=200&page=N[&after=<epoch>]
```

Page until a short page comes back, with 300 ms of pacing between requests. On subsequent
runs pass `after` = the latest `start_date` already stored, minus a one-day safety margin,
and merge by activity id. Write `data/summaries.json`:

```json
{
  "lastSyncTs": 1785790000,
  "activities": {
    "12345678901": {
      "id": 12345678901,
      "name": "Morning Run",
      "sportType": "Run",
      "startDate": "2026-07-14T13:02:11Z",
      "startDateLocal": "2026-07-14T06:02:11Z",
      "startTs": 1784034131,
      "distance": 12873.4,
      "trainer": false,
      "manual": false,
      "hasHeartrate": true,
      "startLatlng": [37.77, -122.42],
      "summaryPolyline": "..."
    }
  }
}
```

Validate every response with `zod` at the boundary and log (do not throw on) unrecognized
fields — Strava adds fields without notice.

`startTs` derives from the UTC `start_date`, never from `start_date_local`, and is the field
every time filter uses. `startDateLocal` is Strava's `start_date_local` and is stored purely
so that calendar bucketing (the scrubber histogram, the per-period bar chart, the year preset
chips) can use the athlete's own calendar rather than the viewing machine's timezone. Both
fields are needed; do not drop either.

`summaryPolyline` is stored for a cheap map preview and for debugging only. **It is far too
simplified for coverage math** — this is precisely the error that makes VeloViewer's explorer
tiles over-count — so nothing in the ledger may read it.

### 3.2 Streams

For each activity that passes the exclusion rules in `docs/algorithm.md` section 3.1 and has
no stream file yet:

```
GET /activities/{id}/streams?keys=latlng,time,altitude&key_by_type=true
```

**Wire shape.** With `key_by_type=true` the response is an object keyed by stream type, each
value a Stream object. Any key may be absent:

```json
{
  "latlng":   { "data": [[37.7749, -122.4194]], "series_type": "distance", "original_size": 2431, "resolution": "high" },
  "time":     { "data": [0, 1], "series_type": "distance", "original_size": 2431, "resolution": "high" },
  "altitude": { "data": [12.4, 12.6], "series_type": "distance", "original_size": 2431, "resolution": "high" }
}
```

The `StreamSet` zod schema in `packages/strava/types.ts` validates this shape with **every
top-level key optional**, requiring only `data` inside each stream object, and treating
`series_type`, `original_size`, `resolution`, and unknown fields under the existing "log, do
not throw" policy. `sync.ts` extracts each stream's `.data` array to produce the flattened
cache file below — the cache format and the wire format are deliberately different.

One request per activity; this is the expensive part. Write `data/streams/{id}.json.gz`
(gzip via `pako`):

```json
{
  "id": 12345678901,
  "fetchedAt": 1785790000,
  "latlng": [[37.7749, -122.4194], [37.7750, -122.4193]],
  "time": [0, 1],
  "altitude": [12.4, 12.6]
}
```

Notes:

- `time` is seconds from activity start; absolute time is `startTs + time[i]`.
- `altitude` may be absent. That is fine; the altitude gate is skipped for those activities
  (and the switchback case A6 degrades, as documented).
- No GPS manifests two ways. HTTP 200 with the `latlng` key entirely **absent** —
  `key_by_type=true` omits unavailable streams, so a treadmill run with heart-rate data
  returns a valid response with no `latlng` — or an empty/short array. And HTTP 404, which
  means the activity has no streams at all (typically a manual entry). Record either case as
  `skipped:no-gps` in `sync-state.json` so it is never retried. Both are rare in practice,
  because the manual, trainer, and `Virtual*` rules in `docs/algorithm.md` section 3.1 already
  exclude most such activities before the fetch.

### 3.3 Resumability and rate limits

`data/sync-state.json` is rewritten after **every** activity:

```json
{
  "summariesFetchedAt": 1785790000,
  "streams": { "12345678901": "ok", "12345678902": "skipped:no-gps", "12345678903": "error:500" },
  "lastError": null
}
```

`skipped:*` statuses are permanent and never retried; `error:*` statuses are transient and
re-attempted on the next run. A 404 or an absent `latlng` is recorded as `skipped:no-gps`, per
section 3.2 — never as an error.

Rate-limit handling, which the script must get right because a full backfill spans hours:

- Parse `X-ReadRateLimit-Usage` and `X-ReadRateLimit-Limit` from every response and keep a
  running view of headroom.
- On HTTP 429, honor `Retry-After` if present; otherwise sleep until the top of the next
  15-minute window (Strava's windows align to :00, :15, :30, :45).
- Track the daily budget separately. When the daily read limit is exhausted, stop cleanly,
  print how many activities remain and to resume tomorrow, and exit 0 — this is a normal
  outcome for a large backfill, not an error.
- Print a progress line roughly every 25 activities: count done, count remaining, and an ETA
  derived from the remaining rate-limit windows.

Backfill arithmetic at the upgraded limit: 200 reads per 15 minutes is 800 per hour, so 2,000
activities is about 2.5 hours, and the 2,000-per-day cap binds above roughly 2,000
activities.

Escape hatch, worth knowing but not part of the spec'd path: Strava's account-level bulk
export (Settings > My Account > Download your account) delivers the whole history as
FIT/GPX/TCX with no rate limit at all. Do not build an importer for it unless asked.

### 3.4 Sport groups

Assigned at sync time and stored on each activity. `Other` is the fallback for any sport type
with usable GPS that is not listed.

| Group | `sport_type` values |
|---|---|
| `foot` | Run, TrailRun, Walk, Hike, Snowshoe, Wheelchair |
| `ride` | Ride, GravelRide, MountainBikeRide, EBikeRide, Handcycle, Velomobile |
| `ski` | NordicSki, AlpineSki, BackcountrySki, RollerSki |
| `water` | Kayaking, Canoeing, Rowing, StandUpPaddling, Surfing, Swim |
| `other` | everything else |

The group order above is fixed and is the index order used by `firstTsByGroup` in the
artifacts. Do not reorder it.

---

## 4. Build (`npm run build:ledger`)

`scripts/build-ledger.ts`:

1. Read `data/summaries.json`; sort by `(startTs, id)` ascending.
2. Stream in each activity's GPS data from `data/streams/{id}.json.gz`.
3. Call `packages/ledger`, which owns all algorithm logic and touches no files.
4. Serialize the artifacts into `app/public/artifacts/`.
5. Print a summary: activity count, site count, unique versus total mileage, elapsed time.

If `data/summaries.json` is absent, exit 0 with "no data/ present — run `npm run sync` first"
rather than throwing. This keeps `npm run build` usable in a clean checkout.

The build is always a full rebuild from scratch. There is no incremental path, and adding one
does not pay for itself: a full build is seconds, and rebuilding is what guarantees that
chronological credit attribution is stable when older activities arrive out of order.

---

## 5. Artifact formats

All binary files are little-endian. Every block is padded to a multiple of 8 bytes so that
typed-array views can be created over the buffer with zero copies. The manifest carries an
explicit `byteOffset` and `length` for every block; **the reader must use those values rather
than recomputing offsets**, so that adding a column later does not break older readers loudly
in the wrong place.

### 5.1 `manifest.json`

```json
{
  "formatVersion": 1,
  "builtAt": "2026-08-03T18:22:04Z",
  "paramsHash": "fnv1a:9f2c4b17",
  "params": { "RESAMPLE_M": 8, "R_REP": 20, "R_NEW": 30, "...": "..." },
  "sportGroups": ["foot", "ride", "ski", "water", "other"],
  "counts": { "activities": 2841, "sites": 1042117, "touches": 3410992, "trackPoints": 3486220 },
  "bounds": { "minLng": -122.6, "minLat": 37.6, "maxLng": -122.3, "maxLat": 37.9 },
  "timeRange": { "minTs": 1420070400, "maxTs": 1785600000 },
  "totals": { "uniqueMeters": 8336936.0, "totalMeters": 27889760.0 },
  "files": {
    "sites": {
      "path": "sites.bin",
      "byteLength": 40642608,
      "blocks": {
        "x":        { "byteOffset": 0,        "length": 1042117, "type": "Int32"  },
        "y":        { "byteOffset": 4168472,  "length": 1042117, "type": "Int32"  },
        "bearing":  { "byteOffset": 8336944,  "length": 1042117, "type": "Uint8"  },
        "creditCm": { "byteOffset": 9379064,  "length": 1042117, "type": "Uint16" },
        "mintTs":   { "byteOffset": 11463304, "length": 1042117, "type": "Uint32" },
        "mintAct":  { "byteOffset": 15631776, "length": 1042117, "type": "Uint32" },
        "firstTsByGroup": [
          { "byteOffset": 19800248, "length": 1042117, "type": "Uint32" },
          { "byteOffset": 23968720, "length": 1042117, "type": "Uint32" },
          { "byteOffset": 28137192, "length": 1042117, "type": "Uint32" },
          { "byteOffset": 32305664, "length": 1042117, "type": "Uint32" },
          { "byteOffset": 36474136, "length": 1042117, "type": "Uint32" }
        ]
      }
    },
    "touches":    { "path": "touches.bin",    "blocks": { "actOffsets": {}, "siteIds": {} } },
    "tracks":     { "path": "tracks.bin",     "blocks": { "trackOffsets": {}, "px": {}, "py": {}, "flag": {} } },
    "activities": { "path": "activities.json" }
  }
}
```

Byte offsets above are illustrative; the writer computes them. `firstTsByGroup` is an array
with one entry per sport group, in the fixed order from section 3.4.

The example is internally consistent and is worth using as a sanity fixture: `firstTsByGroup`
has one entry per sport group (five), each block is 8-byte aligned, and `byteLength` equals
the last block's offset plus its size (19,800,248 + 5 x 4,168,472 = 40,642,608).

Two invariants worth asserting in the build script:

- `counts.touches <= counts.trackPoints`, because Pass II emits at most one touch per resampled
  sample and per-activity touch lists are then deduplicated.
- `totals.uniqueMeters` is approximately `counts.sites * RESAMPLE_M` (each surviving site
  accounts for one resample quantum), and `totals.totalMeters` is approximately
  `counts.trackPoints * RESAMPLE_M`. A build whose totals are wildly off these is reporting
  numbers from somewhere other than the site table.

### 5.2 `sites.bin`

One block per column, in the order listed. Site ids are the array index, ascending in mint
order, so `mintTs` is non-decreasing.

| Block | Type | Meaning |
|---|---|---|
| `x`, `y` | `Int32` | Web Mercator **centimetres** (Mercator metres times 100) |
| `bearing` | `Uint8` | encoded direction, 0..179, representing 0..358 degrees |
| `creditCm` | `Uint16` | unique ground this site accounts for, in centimetres (8 m becomes 800) |
| `mintTs` | `Uint32` | start timestamp of the activity that first covered this ground |
| `mintAct` | `Uint32` | index into `activities.json` |
| `firstTsByGroup[g]` | `Uint32` | earliest activity start time in group `g` touching this site; `0xFFFFFFFF` means never |

Altitude is a build-time field only and is not written to artifacts.

### 5.3 `touches.bin`

Compressed-sparse-row mapping of activity to the site ids it covered.

| Block | Type | Length |
|---|---|---|
| `actOffsets` | `Uint32` | `nActivities + 1` |
| `siteIds` | `Uint32` | `nTouches` |

Activity `a`'s sites are `siteIds[actOffsets[a] .. actOffsets[a+1])`, **sorted ascending and
deduplicated**. This is the array the query fold walks; sorted order gives it sequential
memory access.

### 5.4 `tracks.bin` (lazily loaded)

Per-activity resampled geometry, needed only for playback highlighting and activity selection.
Fetched on first use, not at startup.

| Block | Type | Length |
|---|---|---|
| `trackOffsets` | `Uint32` | `nActivities + 1` |
| `px`, `py` | `Int32` | `nTrackPoints`, Mercator centimetres |
| `flag` | `Uint8` | `nTrackPoints` |

`flag` is a bit field:

| Bit | Meaning |
|---|---|
| 0-1 | label: 0 NEW, 1 REPEAT, 2 AMBIGUOUS, 3 NONE |
| 2 | this sample starts a new leg (renderers must break the path here) |

### 5.5 `activities.json`

```json
[
  {
    "idx": 0,
    "stravaId": 12345678901,
    "name": "Morning Run",
    "startTs": 1784034131,
    "startDateLocal": "2026-07-14T06:02:11Z",
    "sportType": "Run",
    "group": 0,
    "distanceM": 12873.4,
    "newGroundM": 4210.2,
    "bbox": [-122.48, 37.74, -122.39, 37.81]
  }
]
```

`idx` is the array position and the id used by `touches.bin` and `tracks.bin`. `group` is an
index into `manifest.sportGroups`.

`startTs` drives every time filter; `startDateLocal` is carried through solely so the app can
bucket by the athlete's own calendar (`SPEC.md` section 6.4). Both are required — the app
loads no other per-activity file.

`newGroundM` is the ground this activity minted **over the whole history with no sport
filter**. It is therefore the right value for the unfiltered "biggest discoveries" table and
the wrong value under a sport filter; see `SPEC.md` section 6.5 for how the drawer handles that.

**Membership rule.** `activities.json` contains exactly the activities the ledger processed —
those passing the exclusion rules in `docs/algorithm.md` section 3.1 — in build order
`(startTs, id)` ascending, with `idx` contiguous from zero. `nActivities` in sections 5.3 and
5.4 and `manifest.counts.activities` are all the length of this array. Trainer, manual,
virtual, and GPS-less activities are absent entirely, which is why "total logged" in the app
is the sum of recorded distances of *included* activities and will not match Strava's own
yearly totals. That divergence is stated in the app's "How this is calculated" panel rather
than hidden.

---

## 6. Loading in the browser

`app/src/worker/query.worker.ts` at startup:

1. `fetch('/artifacts/manifest.json')` and run two distinct checks. Note the **leading slash**:
   a relative URL inside a worker resolves against the worker module's own URL, not the site
   root, so `artifacts/...` would look under `/src/worker/` and 404 into the setup card.
   - If `manifest.formatVersion` does not equal the reader's supported version, the binary
     blocks are **unreadable**. Do not create typed-array views. Post an error the UI renders
     as the setup card with a rebuild instruction.
   - If `formatVersion` matches but `manifest.paramsHash` differs from the hash exported by
     `@um/ledger`'s `params.ts` (which the worker imports directly — the package is pure TS
     with no Node APIs, so it is safe in the browser), post a warning the UI renders as the
     params-mismatch banner from `SPEC.md` section 6.6. The app still renders
     normally in this case; the data is readable, just built with different parameters.
2. `fetch` `sites.bin`, `touches.bin`, and `activities.json`, reporting progress to the main
   thread via `Response.body` reader chunks so the loading bar is determinate.
3. Create typed-array views over each block using the manifest's offsets. **Do not copy.**
4. Derive the render geometry once: for each site, compute the two endpoints of its
   segment — `position +/- (RESAMPLE_M / 2)` along its bearing, converted to longitude and
   latitude — into two `Float32Array`s of length `2 * nSites`. Transfer them to the main
   thread once; they never change again.

   `Float32` longitude and latitude gives about 0.6 m of precision at typical longitudes,
   which is well inside an 8 m mark.
5. Allocate the working arrays that persist for the session: `visitCount: Uint16Array(nSites)`,
   plus **two** color buffers `colorsA` and `colorsB`, each `Uint8Array(4 * nSites)`, used as a
   ping-pong pair.

   **Implementation note, and a deliberate deviation from the ping-pong design above.** In
   practice deck.gl keeps its attribute typed array and re-reads it on every redraw, not only
   at upload. Any buffer transferred back to the worker is therefore detached out from under a
   live layer, and the coverage layer silently renders nothing the next time the map moves.
   Waiting a frame or two before releasing does not fix it, because there is no point after
   which deck.gl is done with the array.

   What is implemented instead: the worker still owns two slots and still transfers, but the
   **main thread copies the incoming bytes into a stable buffer it owns outright** and releases
   the transferable immediately. deck.gl is handed only that stable buffer, which is never
   transferred, and a monotonically increasing `colorVersion` drives `updateTriggers`. The copy
   is one `set()` over 4 x nSites bytes -- about 4 MB at a million sites, a fraction of a
   millisecond -- and after the first query it allocates nothing, so the playback budget still
   holds. The `slot` field and the release message remain exactly as specified.

Only `tracks.bin` loads on demand, fetched on first playback or activity selection.
`activities.json` is small and loads at startup with the binaries: the fold needs each
activity's `startTs` and group before it can run at all, and the scrubber histogram needs
per-activity distance before the first render.

Total resident: roughly 40 MB of site columns, 14 MB of touches, 17 MB of derived positions,
and 10 MB of working arrays (the visit counts plus both color buffers), plus about 30 MB of
tracks once loaded. Comfortably inside the 400 MB budget.

---

## 7. Operational notes for `CLAUDE.md`

The repo's `CLAUDE.md` should carry only the things that cannot be discovered by reading the
code:

- Credentials live in `.env.local` and `.strava-token.json`, both gitignored. Never print
  token values.
- unique-miles uses its **own** Strava app registration, deliberately separate from the one
  another tool and `another tool` share. Do not point it at the another tool's credentials; see section 1.2.
- `npm run sync` is resumable and expected to take hours on a first backfill. Re-run it; it
  picks up where it stopped.
- `npm run build:ledger` is a full rebuild every time, by design.
- `data/` and `app/public/artifacts/` are gitignored and regenerable. Nothing in them is
  precious except the hours of API budget spent filling `data/streams/`.
