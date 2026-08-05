# SiteLedger v2 — the uniqueness algorithm

This document fully specifies how GroundCover decides which ground is new. It is written
to be implemented directly, without design decisions left to the implementer. Where a
parameter appears, its value and its justification are both given; do not change values
without reading the justification.

The algorithm lives in `packages/ledger` and must be **pure TypeScript with no Node APIs**.
It takes activities in and returns typed arrays out. All file I/O belongs to
`scripts/build-ledger.ts`.

**The test suite in section 10 is the specification of correct behavior.** Write those tests
first. If the implementation and a test disagree, the test is right.

---

## 1. The idea in one paragraph

Resample every activity to a point every 8 metres. Process all activities in strict
chronological order. Maintain one append-only table of **sites**: accepted representative
points, each carrying a position, a direction of travel, an altitude, a credit length, and
the time it was first covered. For each resampled point, find nearby sites travelling in a
compatible direction. Within 20 m means you have been here — no credit. Beyond 30 m from
everything means this is new — mint a site and take the credit. Between 20 and 30 m is a
deliberate dead zone that grants neither. Unique mileage is the sum of the credit lengths
of all minted sites.

The dead zone is the whole trick. Without it, a road you have run 200 times slowly grows a
phantom envelope as GPS noise pushes individual passes just past the matching radius, and
your "new miles" number inflates forever. Requiring clear separation before granting credit
makes phantom growth require a sustained multi-sigma excursion rather than ordinary jitter.

---

## 2. Coordinates, units, and primitives

### 2.1 Coordinate system

All internal geometry is **Web Mercator (EPSG:3857) metres**, stored during the build as
`Float64` and in artifacts as `Int32` centimetres (the range +/-20,037,508 m fits: 2.0e9 <
2.147e9).

Mercator distances are inflated by `1 / cos(latitude)`. True ground distance is therefore:

```ts
// (x, y) in Mercator metres; cosLat = cos(latitude) at the query point.
// Valid only for nearby points (< ~1 km), which is all this algorithm ever compares.
function groundDist(x1: number, y1: number, x2: number, y2: number, cosLat: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  return Math.hypot(dx, dy) * cosLat;
}
```

Every resampled point stores its own `cosLat` (`Float32`) computed once during
preprocessing. Candidate sites are always within 50 m, where `cosLat` is identical to more
decimal places than matters, so the query point's value is used for both.

Using a single global projection instead of a per-activity local frame means multi-hundred-
kilometre activities need no special handling.

Conversions:

```ts
const R = 6378137;
const lngToX = (lng: number) => (lng * Math.PI / 180) * R;
const latToY  = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2)) * R;
const xToLng  = (x: number) => (x / R) * 180 / Math.PI;
const yToLat  = (y: number) => (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
```

### 2.2 Bearings

Bearings are stored as a `Uint8` in units of 2 degrees, values 0..179, representing 0..358
degrees of true (modulo 360) travel direction:

```ts
const encodeBearing = (deg360: number) => Math.round(((deg360 % 360) + 360) % 360 / 2) % 180;

/** Difference of two encoded bearings, modulo 360, in degrees, range [0, 180]. */
function angDiff360(a: number, b: number): number {
  const d = Math.abs(a - b) * 2;
  return d > 180 ? 360 - d : d;
}

/** Difference of two encoded bearings, modulo 180, in degrees, range [0, 90]. */
function angDiff180(a: number, b: number): number {
  const d = angDiff360(a, b);
  return d > 90 ? 180 - d : d;
}
```

Matching uses `angDiff180`, because the same road travelled in opposite directions is the
same road. The U-turn dedup pass (section 5.3) uses `angDiff360`, because it specifically
needs to find anti-parallel pairs. Storing the full direction in one byte gives both.

A point's bearing is measured over a **+/-16 m along-track baseline** (two resampled samples
either side at 8 m spacing), not between adjacent samples. With 3-5 m point noise, an 8 m
baseline yields roughly +/-40 degrees of bearing error, which is useless against a
45-degree tolerance; a 32 m total baseline brings it to roughly +/-12 degrees. At leg ends
where fewer neighbours exist, use the widest available baseline.

### 2.3 Spatial index for the build

A uniform grid hash over sites: `Map<number, number[]>` mapping a packed cell key to a list
of site ids.

```ts
const CELL_MERC = 64;                                  // Mercator metres
const cellOf = (v: number) => Math.floor(v / CELL_MERC) + (1 << 25);   // non-negative
const cellKey = (cx: number, cy: number) => cy * 67108864 + cx;        // cy * 2^26 + cx
```

Both `cx` and `cy` fit in 26 bits, so the key is an exact integer below 2^52 and works as a
plain JavaScript number key. **Do not use BigInt or string keys** — either costs 5-10x in
the hot loop.

A query at point `p` for radius `r` ground metres scans a neighbourhood of radius

```ts
const cellRadius = Math.ceil(r / (CELL_MERC * p.cosLat));
```

cells in each direction. That is 1 (a 3x3 scan) below 62 degrees of latitude and 2 beyond,
which keeps the candidate set complete at any latitude.

---

## 3. The package interface, and Stage 1 — per-activity preprocessing

Section 3.0 defines what `packages/ledger` exports. Everything from 3.1 onward is Stage 1:
a pure function of one activity's streams, where each numbered step is separately
unit-testable and the order matters.

### 3.0 The package's public interface

`packages/ledger` exports exactly one entry point. Everything else is internal.

```ts
export interface LedgerInput {
  id: number;            // Strava activity id
  name: string;
  startTs: number;       // unix seconds, from start_date (UTC)
  startDateLocal: string; // Strava start_date_local, passed straight through to artifacts
  sportType: string;     // raw Strava sport_type
  sportGroup: number;    // index into SPORT_GROUPS
  trainer: boolean;
  manual: boolean;
  distanceM: number;     // Strava's recorded distance; needed by the treadmill backstop in 3.1
  latlng: Array<[number, number]>;
  time: number[];        // seconds from start
  altitude?: number[];
}

export interface ActivitySummary {   // one entry per surviving activity; becomes activities.json
  idx: number;
  stravaId: number;
  name: string;
  startTs: number;
  startDateLocal: string;
  sportType: string;
  group: number;
  distanceM: number;
  newGroundM: number;
  bbox: [number, number, number, number];   // minLng, minLat, maxLng, maxLat
}

export interface LedgerOutput {
  manifest: Manifest;                 // complete, INCLUDING every `files` byte offset, since
                                      // this call is what laid the buffers out. The only field
                                      // left blank is `builtAt`, which build-ledger.ts stamps
  sites: ArrayBuffer;
  touches: ArrayBuffer;
  tracks: ArrayBuffer;
  activities: ActivitySummary[];      // exactly the activities that survived exclusion
}

export function buildLedger(input: LedgerInput[], params: Params): LedgerOutput;
```

`Manifest` and `Params` are declared in `types.ts` and `params.ts` and mirror
`docs/data-pipeline.md` section 5.1 and section 8 of this document field for field.

`buildLedger` sorts its input by `(startTs, id)` itself — callers need not pre-sort — and is a
pure function of `(input, params)`. `scripts/build-ledger.ts` reads `data/`, maps it into
`LedgerInput[]`, calls this once, and writes the four buffers out. It performs no algorithm
logic of its own.

Input per activity, as above: identity, timing, sport classification, the exclusion flags, the
recorded distance, and the `latlng`, `time`, and `altitude` streams.

### 3.1 Exclusion

Drop the entire activity if any of:

- `sportType` is `VirtualRide`, `VirtualRun`, `VirtualRow`, or any type beginning `Virtual`.
- `trainer === true` or `manual === true`.
- The `latlng` stream is missing or has fewer than 2 points.
- **Treadmill backstop**: at least 95 percent of raw points lie within 50 m of the point
  centroid while the activity's recorded distance exceeds 1 km.

Flags come first and geometry second, deliberately: Zwift and other virtual worlds are
overlaid on real geography, so no geometric test can catch them. The treadmill backstop
catches the opposite case, a real GPS device that never moved.

### 3.2 Timestamp assembly and deduplication

Absolute time per point is `startTs + time[i]`. Drop any point where `dt <= 0` relative to
its predecessor, or where `(t, lat, lng)` exactly repeats the predecessor. This must precede
any speed computation, or a zero `dt` yields infinite speed.

### 3.3 Spike filter

Apply a 3-point median filter to the latitude and longitude series independently. This
removes single-sample GPS spikes, which a speed cap alone will not (a spike out and back in
one second can be under any cap in each direction). Endpoints pass through unchanged.

Strava's stream API exposes no per-point horizontal accuracy field, so there is no accuracy
gate. If a future data source provides one, drop points reporting worse than 50 m.

### 3.4 Leg splitting

Walk consecutive point pairs. Start a **new leg** — never interpolate or credit across the
boundary — whenever any of:

- chord distance > `GAP_SPLIT_M` = 60 m
- time delta > `GAP_SPLIT_S` = 60 s
- implied speed > the sport group's cap

| Sport group | Speed cap (m/s) |
|---|---|
| Foot | 12.5 |
| Ride | 30 |
| Ski | 40 |
| Water | 8 |
| Other / unknown | 35 |

Split, never delete. Deleting the far endpoint of a jump merely relocates the jump.

The caps sit deliberately above elite human performance (12.5 m/s exceeds Usain Bolt's peak)
so that nothing real is ever discarded. The 60 m chord rule is the real teleport catcher: a
watch left running during a car ride produces enormous chords, and a tunnel or canyon
dropout produces a large chord with a long time delta. Garmin smart recording spaces points
15-48 m apart, comfortably under 60 m, so ordinary sparse recording interpolates normally.

### 3.5 Stationary collapse

Collapse stationary stretches to a single point.

**First, a precheck.** If *every* point of the leg lies within `STATION_D` of the leg's first
point, return the leg untouched. A leg that never leaves the radius at all is not a stationary
stretch inside an activity; it is an activity that did not go anywhere -- a treadmill (already
caught by the exclusion backstop in 3.1) or genuine movement on a very small loop. Three laps
of a 40 m cul-de-sac never leave a 13 m radius, and without this precheck the scan below
collapses the entire activity to a single point and credits zero. The dead zone and the
short-run rule bound whatever such a leg contributes.

Otherwise, use this greedy scan:

```
input:  src = the leg's points
output: out = [] (never mutate src while scanning)

i = 0
while i < src.length:
  k = i
  while k + 1 < src.length AND groundDist(src[k + 1], src[i]) <= STATION_D:
    k = k + 1
  if k > i AND (t[k] - t[i]) >= STATION_S:
    out.push(point at centroid(src[i..k]), ts = round((t[i] + t[k]) / 2))
    i = k + 1
  else:
    out.push(src[i])
    i = i + 1
```

`STATION_S` = 90 s, `STATION_D` = 24 m. Three properties make this the right formulation:

**It reads from `src` and writes to `out`.** Collapsing in place would invalidate `k` the
moment the array shrank, and the scan would silently skip points.

**The predicate is measured from the anchor point `src[i]`, not from a running centroid.** A
centroid-based rule would be circular — the window defines the centroid and the centroid
defines the window — and not monotone under extension, so "the maximal window" would not even
be well defined. Distance from a fixed anchor is monotone in the obvious way: once a point
falls outside, the window ends, and every point up to that one is inside. `STATION_D` is set
to twice the intended 12 m scatter radius precisely because the anchor sits at the edge of a
blob rather than at its middle.

**It is linear in practice.** One distance computation per extension, and a successful collapse
skips the whole window. While actually moving, the window ends after a handful of points (an
athlete at 1 m/s leaves a 24 m radius in 24 samples, at 3 m/s in 8), so the cost stays within
the preprocessing budget in section 11. A centroid-recomputing variant would be O(n * w^2) at
*every* index, not only inside stationary runs, and would blow that budget on slow activities.

The thresholds still trade against slow real motion, and the cutoff is exactly
`STATION_D / STATION_S` = 0.27 m/s: anything sustaining under about 1 km/h collapses. A hiker
scrambling at 0.3 m/s escapes the 24 m radius in 80 s, before the window qualifies. A
ten-minute coffee stop with GPS scattering across a 20 m circle never exceeds 20 m from any
anchor inside it, so it collapses. Collapsing to a **point** rather than a path is what makes
this work at all: a stationary blob cannot paint the ground around it.

Jitter that occasionally throws a point beyond 24 m from the anchor means the collapse fires on
sub-windows instead of the whole stop. The residual is bounded by the short-run rule (section
5.2) rather than growing with the duration of the stop.

### 3.6 Resample

Within each leg, resample the polyline to a fixed along-track spacing of `RESAMPLE_M` = 8 m
by linear interpolation in Mercator coordinates, with along-track distance measured as true
ground distance.

Sample positions along a leg of ground length `L` are `0, 8, 16, ..., L` — that is,
`ceil(L / 8) + 1` samples with the last one landing exactly on the leg end.

Each resampled sample stores:

| Field | Type | Meaning |
|---|---|---|
| `x`, `y` | Float64 | Mercator metres |
| `cosLat` | Float32 | cosine of latitude at this point |
| `ts` | Uint32 | interpolated absolute unix seconds |
| `s` | Float64 | cumulative along-track ground metres **across the whole activity**, legs contributing zero for the gaps |
| `creditM` | Float32 | see below |
| `bearing` | Uint8 | encoded per section 2.2 |
| `alt` | Int16 or null | metres, from the altitude stream if present |
| `legIndex` | Uint16 | which leg this sample belongs to |

Credit is assigned midpoint to midpoint so that a leg's credits sum exactly to its length:

```ts
for (let i = 0; i < n; i++) {
  const prev = i === 0     ? s[0]     : (s[i - 1] + s[i]) / 2;
  const next = i === n - 1 ? s[n - 1] : (s[i] + s[i + 1]) / 2;
  credit[i] = next - prev;
}
// n === 1 is a special case: credit[0] = legLength.
```

`RESAMPLE_M` must stay at or below `R_REP / 2` so that a repeat pass can never step over a
site. At 8 m spacing, a repeat sample is at most 4 m along-track from some prior site plus
about 10 m of cross-track error, roughly 11 m total, comfortably inside the 20 m gate. A
single spacing for all sports (rather than 5 m for foot and 10 m for bike) keeps one code
path and makes credit quanta uniform regardless of which sport discovered the ground.

---

## 4. Stage 2 — the ledger

### 4.1 Global state

Built once per build, in memory, inside `packages/ledger` (`scripts/build-ledger.ts` only
feeds it activities and writes out the resulting artifacts):

- **Site table** (columnar, append-only, grown as parallel arrays):

  | Column | Type | Meaning |
  |---|---|---|
  | `x`, `y` | Float64 | Mercator metres |
  | `bearing` | Uint8 | encoded direction of travel |
  | `alt` | Int16 | metres, or `-32768` for none |
  | `creditM` | Float32 | metres of unique ground this site accounts for |
  | `mintTs` | Uint32 | **start timestamp of the minting activity** |
  | `mintAct` | Uint32 | index of the minting activity |
  | `mintS` | Float64 | along-track position of the minting sample, used by the guard |
  | `alive` | Uint8 | 1 normally, 0 once tombstoned |

- **Grid hash** over live sites, per section 2.3.

Activities are processed in ascending `(startTs, stravaId)` order. That order, and nothing
else, decides which activity gets credit for shared ground. Since `build-ledger` always
rebuilds from scratch, this is automatically stable under backfill.

### 4.2 Candidate query

```
candidates(sample p, radius r, opts) =
  all live sites within r ground metres of p, EXCLUDING:
    (bearing)  angDiff180(site.bearing, p.bearing) > BEARING_TOL
    (guard)    opts.applyGuard AND site.mintAct === currentActivity
                             AND |site.mintS - p.s| < GUARD_ALONG
    (altitude) site.mintAct === currentActivity
                             AND both altitudes exist
                             AND |site.alt - p.alt| > ALT_GATE
  returned as the single nearest survivor; ties broken by lowest site id.
```

Three things about this deserve emphasis.

**Both gates are bearing-filtered.** This is what makes crossing a road you have already
covered cost nothing: the cross street's sites are 90 degrees off, so they are not
candidates at all, and the new street mints straight through the intersection.

**The guard is measured along-track, not in time**, so a mid-activity pause never breaks it.
It exists so that the samples an activity just minted, 8 and 16 m back, do not immediately
count as "ground already covered" and stall forward progress. `GUARD_ALONG` = 50 m exceeds
`R_NEW` = 30 m with curvature margin: the chord across a 50 m arc stays above 30 m for turn
radii above about 17 m, and a 400 m running track's turns are about 36 m.

**The altitude gate is same-activity only.** Within one activity, barometric altitude is
good to a few metres, so a 10 m threshold separates stacked switchback legs. Across
activities, absolute barometric altitude drifts tens of metres with the weather; comparing
across days would make a repeated climb on a high-pressure day look like brand new ground
and mint a full phantom copy of the route. This scoping is not optional.

### 4.3 Pass I — classify and mint

For each sample `p` of the activity, in stream order:

```
c = candidates(p, R_NEW, { applyGuard: true })

if      c exists and dist(c) <= R_REP:   label REPEAT
else if c exists and dist(c) <= R_NEW:   label AMBIGUOUS
else if wrappedBack(p):                  label REPEAT          // see below
else:
  label NEW
  mint a site at p (position, bearing, alt, creditM = p.creditM,
                    mintTs = activity.startTs, mintAct, mintS = p.s)
  insert it into the grid immediately
```

### 4.3.1 The wrap-repeat rule

`wrappedBack(p)` is true when there exists a same-activity site `S` (found by ignoring the
guard, but still subject to the bearing and altitude gates) such that:

```
groundDist(p, S) <= R_REP
AND (p.s - S.mintS) - groundDist(p, S) > R_REP
```

The second condition says the track has travelled at least `R_REP` farther along than its net
displacement from `S` — it has genuinely looped back on itself rather than merely moved
forward. On ordinary forward progress the site minted 8 m earlier has along-track separation
approximately equal to spatial distance, so the expression is near zero and the rule never
fires. On a closed loop it fires as soon as the loop closes.

Two properties make this easy to reason about. `S` is always minted by an earlier sample of the
same activity, so `p.s - S.mintS` is never negative. And because this branch is reached only
when the guarded query found nothing within `R_NEW`, `S` is necessarily guard-hidden, so
`p.s - S.mintS < GUARD_ALONG` = 50 m. The rule therefore fires only for sites within 50 m
along-track and 20 m in space whose along-track separation exceeds their spatial separation by
more than 20 m — which is a tight loop and essentially nothing else. Ground revisited later in
the same activity is caught by the ordinary guarded query, not here, because at that
along-track separation the guard no longer hides it.

This exists because the guard is measured along-track, and on a loop shorter than
`GUARD_ALONG` = 50 m every site from the current lap stays guard-hidden for the entire lap.
Without this rule, a 40 m cul-de-sac bulb mints a second, spatially coincident set of sites on
its second lap — same position, same bearing, so the U-turn dedup pass (which requires
anti-parallel travel) can never remove them.

Small closed loops remain partially credited even with this rule; see the A14 row in section 9.

Minting **eagerly**, inside the same pass that reads the grid, is the single most important
implementation detail in this document. It is what makes an out-and-back count once (the
return leg matches the outbound leg's sites) and 25 laps of a track credit about 400 m
rather than 10 km (laps 2 through 25 match lap 1's sites, which are 400 m away along-track
and therefore outside the guard). Any implementation that defers site creation to a commit
step after the matching pass is wrong and will double-count virgin out-and-backs.

---

## 5. Stage 3 — tombstone passes

These run after Pass I, over the activity's tentative sites, before attribution. Each one
removes sites; none adds any.

### 5.1 Why sample-to-site links are not recorded in Pass I

Pass I records only labels, not which site each sample matched. Site references are assigned
in Pass II (section 6), after all tombstoning. This deliberately avoids an entire class of
dangling-reference bugs, at the cost of one extra grid query per sample. Do not optimize it
away by recording links in Pass I.

### 5.2 Short-run rule

Find maximal runs of consecutive `NEW` samples. If a run's total credit length is below
`L_MIN` = 24 m (three samples at 8 m), tombstone every site the run minted.

This closes the one real accretion channel the hysteresis band leaves open. Urban multipath
error is autocorrelated and heavy-tailed: it arrives in bursts of several consecutive
samples 30-50 m off the true corridor, which survive the median filter (which only kills
single samples) and are far too short for the offset detector's 200 m floor. Without this
rule, such bursts mint permanent phantom ground on every canyon pass, and a heavily repeated
commute corridor accretes several percent of phantom mileage over years.

The cost is honest and worth stating in the UI, and it has two parts. A genuinely new fragment
shorter than 24 m — a short alley connecting two streets you already know — is never credited,
and is re-discarded on every future pass. Less obviously, the rule also erodes *long* new
ground that runs close enough to old coverage for noise to interleave dead-zone samples
through it: the surviving NEW stretches between those samples are themselves short, fall below
`L_MIN`, and are tombstoned. That is what makes the effective dead zone extend past `R_NEW`
(see the A3 row in section 9). A future version could instead mint such runs as
provisional and confirm them when a second activity independently covers the same ground,
which recovers the alley while still rejecting multipath. That is deliberately deferred; it
adds back-dated timestamps and a two-state lifecycle that are not worth the complexity in v1.

### 5.3 U-turn dedup

For each surviving tentative site `S`, in ascending mint order, search for an **earlier,
still-alive site `E` minted by the same activity** that is:

- within `R_REP` = 20 m ground distance,
- compatible modulo 180 (`angDiff180 <= BEARING_TOL`),
- **anti-parallel modulo 360** (`angDiff360 > 120` degrees),
- passes the same-activity altitude gate,
- and **folded back**: `groundDist(S, E) < FOLDBACK_RATIO * |S.mintS - E.mintS|`, with
  `FOLDBACK_RATIO` = 0.4.

If one is found, tombstone `S`. Tombstones take effect immediately, so a site removed earlier
in this pass is not available as an anchor for a later one. Sites already removed by the
short-run rule are likewise not anchors.

Ship this pass behind `params.uTurnDedup: boolean`, default `true`; the flag exists so that
test A1b can isolate and quantify the pass's effect.

This removes the turnaround artifact. At the apex of an out-and-back, the guard hides the
outbound sites nearest to the return point, so the first roughly 10 m of the return leg
mints duplicate sites. Working through the geometry: a return sample `d` metres past the
apex has its mirror outbound site `2d` away along-track, hidden while `2d < 50`; the nearest
*visible* compatible site sits `|50 - 2d|` metres away in space, which exceeds `R_NEW` only
while `d < 10`. Across hundreds of out-and-backs those slivers add up to kilometres of
phantom credit. The short-run rule does not catch them, because the apex slivers are
contiguous in sample order with the long genuine NEW run of the outbound leg.

The anti-parallel condition alone is not enough, and this is the subtle part. It correctly
excludes ordinary forward progress, which is parallel to the site minted 8 m earlier. But it
does **not** exclude a tight hairpin: two sites on a curve of radius 10 m separated by a
150-degree bend sit 19.3 m apart (inside `R_REP`) with `angDiff360` of 150 and `angDiff180` of
30, and the later one legitimately minted — so a rule without the fold-back condition deletes
real ground at every tight switchback turn, permanently and invisibly.

The fold-back condition separates the two cases cleanly, using the ratio of spatial distance
to along-track distance. The two gates above already restrict which pairs are even considered:
`angDiff360 > 120` and `angDiff180 <= 45` together admit only bends between 120 and 225
degrees. Inside that window:

- **Contiguous travel around an arc** has `chord / arc = sin(x/2) / (x/2)` for bend angle `x`,
  which decreases monotonically: 0.827 at 120 degrees, 0.637 at 180, and 0.471 at 225. The
  whole admissible window therefore sits above 0.4 and every hairpin, switchback, and tight
  curve is spared, at any radius.
- **A genuine turnaround duplicate** `d` metres past the apex pairs with an outbound site `e`
  metres before it: spatial distance is about `|e - d|` while along-track separation is
  `e + d`, and `|e - d| < 0.4 (e + d)` holds for every `e` between `0.43d` and `2.33d`. With
  sites every 8 m and `d` under 10 m, partners at `e` = 8 and `e` = 16 both qualify, so the
  artifact is still removed.

So 0.4 sits in a genuine gap: contiguous travel never drops below 0.471, and turnaround
duplicates cluster at 0.33 and below. A threshold of 0.5 would also work arithmetically but
leaves almost no margin — a 40 m closed loop puts a compatible pair at 0.505, which noise
alone would push across.

The residual is at most one 8 m site per turnaround, comfortably inside test A1's asserted
band. The altitude gate continues to preserve whatever switchback separation the activity's
barometer provides.

### 5.4 Offset detector (feature-flagged, implement last)

Handles the case where an entire pass is shifted 30-50 m sideways by urban canyon multipath
— beyond the dead zone's reach, so it would otherwise mint a phantom parallel copy of a
street you know well.

For each maximal run of `NEW` samples at least 200 m long, gather each sample's nearest
compatible **site minted by an earlier activity** within 50 m, ignoring the `R_NEW` floor.
Reclassify the whole run as an offset repeat, tombstoning its sites, if all of:

1. at least 80 percent of the run's samples found such a site;
2. the interquartile range of those distances is below 8 m (a rigid lateral shift, not a road
   that drifts toward and away from another);
3. the run's direction agrees with the matched sites' direction **modulo 360** within 30
   degrees (so the two carriageways of a divided road, which run opposite ways, are never
   merged);
4. the run is *flanked* by matched samples: the samples immediately before and after the run
   both matched history. Test the flanking samples, not the run's own endpoints -- a NEW run
   begins exactly where separation passed `R_NEW`, so its own ends can never be within `R_REP`
   and a condition written that way would never fire.

A consequence worth stating plainly: a pass shifted **uniformly for its entire length**, with no
re-convergence anywhere, is deliberately NOT caught. Such a trace is geometrically
indistinguishable from a genuinely new parallel road, and the detector must not guess. Only a
localized excursion -- ground you know, a rigid departure, ground you know again -- carries the
evidence needed to call it an error.

The five numeric thresholds above are named parameters like every other tunable, and belong in
the `params` object and its hash: `OFFSET_MIN_RUN` = 200 m, `OFFSET_SEARCH` = 50 m,
`OFFSET_MIN_FRAC` = 0.8, `OFFSET_MAX_IQR` = 8 m, `OFFSET_DIR_TOL` = 30 degrees. Without that,
changing one leaves `paramsHash` unchanged and the app reports stale artifacts as fresh.

Ship this behind `params.offsetDetector: boolean`, default `true`, and build it last. Its
failure mode is under-crediting a genuinely new path that runs 30-50 m parallel to old
coverage for 200 m with consistent spacing and rejoins at both ends — rare, and the bias is
deliberately toward under-crediting, because a missing mile is visible and complainable
while a phantom mile is invisible and permanent.

---

## 6. Pass II — attribution

After all tombstoning, walk the activity's samples again. For each sample `p`:

```
c = candidates(p, R_NEW, { applyGuard: false })     // no guard: we want the true nearest

if      c does not exist:                flag NONE,      no touch
else if c was minted by this sample:     flag NEW,       touch c
else if dist(c) <= R_REP:                flag REPEAT,    touch c
else:                                    flag AMBIGUOUS, touch c
```

**AMBIGUOUS samples record a touch.** A pass running 22 m offset — a moderate urban canyon
day — earns no new mileage, which is correct, but it did happen and it must still register
as a visit. Otherwise that pass vanishes from the visit counts, the map renders grey where
you demonstrably ran, and a time window containing only that pass reports zero distinct
ground.

Collect the activity's touches into a **sorted, deduplicated** `Uint32Array` of site ids.
Deduplication per activity is what makes a site's visit count mean "how many distinct
activities covered this ground", which is both the more useful quantity and dramatically
simpler than debounced per-pass counting.

---

## 7. Stage 4 — derived outputs

After every activity has been processed:

1. **Compact the site table**, dropping tombstoned sites and remapping ids so that ids remain
   ascending in mint order. Because activities were processed chronologically, `mintTs` is
   non-decreasing across the compacted table.

   **Every per-activity touch list must be remapped through the same old-id-to-new-id table,
   and re-sorted and re-deduplicated afterwards.** Skipping this is a silent corruption: the
   ids still resolve to real sites, so nothing throws, but every activity points at the wrong
   ground and both the map and the mileage numbers are wrong in a way no assertion catches.
   Build the remap as an `Int32Array(nSitesBeforeCompaction)` holding the new id or `-1` for
   tombstoned entries. Because compaction preserves relative order, translation alone keeps
   each list sorted and duplicate-free — so re-sorting is belt and braces rather than a
   requirement, and cheap enough to do anyway. What is *not* optional is dropping any touch
   that maps to `-1`. Pass II only ever attributes to live sites, so this should never happen;
   assert it rather than silently tolerating it, along with the invariant that every remapped
   id lands in `[0, nSites)`.
2. **Unique mileage** is the sum of `creditM` over all surviving sites.
3. **Per-group first-visit times.** For each sport group `g`, build
   `firstTsByGroup[g]: Uint32Array(nSites)`, initialised to `0xFFFFFFFF`, and set
   `firstTsByGroup[g][siteId] = min(startTs)` over activities in group `g` that touch that
   site. This is what makes the sport filter mean "compute everything as if only these
   sports existed" and keeps that query O(nSites) with no per-site event scanning.
4. **Per-activity new-ground totals**: sum of `creditM` over the sites each activity minted
   that survived. Used by the "biggest discoveries" table.

**All time filtering, everywhere in the application, is by activity start timestamp.** Not
by sample time. An activity qualifies for a window `[t0, t1]` iff `t0 <= startTs <= t1`,
**inclusive on both ends**, deliberately matching the inclusive test applied to
`firstTsByGroup`. That symmetry is what makes the invariant provable: if a site's first
qualifying visit lands inside the window, the activity that made it is itself inside the
window, so the site is also counted as distinct ground. New ground can therefore never exceed
distinct ground, at any window boundary.

---

## 8. Parameters

Every tunable, in one place. Implement as a single frozen `params` object, hashed into the
artifact manifest so the app can detect stale artifacts.

| Name | Default | Justification |
|---|---|---|
| `RESAMPLE_M` | 8 m | At or below `R_REP / 2` so a repeat pass cannot step over a site — a repeat sample is then at most 4 m along-track from some prior site, which with about 10 m of cross-track error stays well inside the 20 m gate. One value for all sports keeps credit quanta uniform regardless of which sport discovered the ground. Note that resampling does **not** shorten the measured path: credit is along-track distance on the source polyline, so raw GPS jitter still inflates total distance the same way Strava's own figures do. Only the *unique* number is protected, and that protection comes from the matching gates, not from resampling. |
| `R_REP` | 20 m | One-dimensional cross-track error at 95 percent is about 1.96 sigma: roughly 10 m in open sky (sigma 5) and 16 m under canopy or in a city (sigma 8). 20 m therefore captures about 95 percent of genuine repeats while staying below a 25-30 m divided road. CityStrides uses 25 m against OSM nodes, which is the ceiling for this band. Do not raise past 25 m. |
| `R_NEW` | 30 m | Credit requires clear separation, 3-6 sigma, from all compatible history. The 20-30 m gap is the accretion brake and absorbs whole-trace offsets up to 30 m. |
| `BEARING_TOL` | 45 deg (mod 180) | Separates perpendicular crossings with margin while tolerating about +/-12 degrees of bearing noise plus road curvature. Explicitly does not separate anti-parallel switchback legs — 180 is congruent to 0 modulo 180 — which is what the altitude gate is for. |
| `BEARING_BASELINE` | +/-16 m along-track | An 8 m baseline with 3 m endpoint noise gives roughly +/-40 degrees of bearing error, useless against a 45 degree tolerance; 32 m total brings it to about +/-12 degrees. |
| `GUARD_ALONG` | 50 m | Must exceed `R_NEW` with curvature margin so freshly minted sites cannot stall forward progress. See 4.2. |
| `L_MIN` | 24 m | Three samples. Long enough to reject autocorrelated multipath bursts, short enough that the loss is limited to genuinely tiny new fragments. |
| `GAP_SPLIT_M` | 60 m | Above Garmin smart recording's 15-48 m spacing, below any real dropout. One rule serves both teleport rejection and the interpolation cap. |
| `GAP_SPLIT_S` | 60 s | Catches paused-watch resumption and tunnel gaps. |
| `SPORT_CAPS` | see 3.4 | Above elite performance so nothing real is dropped; the chord rule is the actual teleport catcher. |
| `STATION_S` / `STATION_D` | 90 s / 24 m | Collapses a stationary blob while sparing motion down to about 0.3 m/s. `STATION_D` is measured from the window's anchor point, so it is twice the intended scatter radius of 12 m. See 3.5. |
| `ALT_GATE` | 10 m | Same-activity comparisons only. Note what it buys and what it does not: adjacent switchback legs converge in altitude as they approach their shared turn, so the gate separates them only over the fraction of each leg where the vertical difference exceeds 10 m — that is `1 - ALT_GATE / (2 * rise)` of the leg. A leg climbing 25 m is separated over 80 percent of its length; a leg climbing 14 m, only 64 percent. The gate rescues steep switchbacks well and shallow ones poorly, which is exactly the shape of the A6 limitation. |
| `CELL_MERC` | 64 m | Grid cell size; the query neighbourhood radius adapts to latitude so the candidate set is always complete. |
| `FOLDBACK_RATIO` | 0.4 | The U-turn pass's fold-back threshold (5.3). Sits in the gap between contiguous travel, which never drops below 0.471 across the admissible bend window, and turnaround duplicates, which cluster at 0.33 and below. |
| `uTurnDedup` | `true` | Feature flag for section 5.3. Exists so tests A1b and A1c can isolate the pass's effect. Part of the params object and its hash, exactly like `offsetDetector`. |
| `offsetDetector` | `true` | Feature flag for section 5.4. |
| `OFFSET_MIN_RUN` / `OFFSET_SEARCH` / `OFFSET_MIN_FRAC` / `OFFSET_MAX_IQR` / `OFFSET_DIR_TOL` | 200 m / 50 m / 0.8 / 8 m / 30 deg | The offset detector's thresholds, justified in 5.4. Named here so that changing one moves `paramsHash`. |

---

## 9. Behavior on hard cases

The full adversarial suite. Every row is a test in section 10. "Fail" rows are deliberate,
documented trade-offs, not oversights, and the ones a user can notice are surfaced in the
app's "How this is calculated" panel.

| # | Case | Behavior | Verdict |
|---|---|---|---|
| A1 | Out-and-back on one road | The return leg matches the outbound leg's eagerly-minted sites. The guard-shadow sliver at the apex (about 10 m) is removed by the U-turn dedup pass. The road counts once. | pass |
| A2 | Same road 100+ times, 5-20 m of GPS spread | Pass 1 credits; later passes inside 20 m are repeats; the 20-30 m band neither credits nor mints. Growth requires a sustained excursion beyond 30 m, and the short-run rule kills the multi-sample bursts that produce one. Residual accretion is a fraction of a percent of corridor length, and is monotonically bounded because annulus samples never mint. | pass |
| A3 | Divided road, carriageways 25-30 m apart | The second carriageway falls in the dead zone: no credit, no phantom, but it does register as a visit. Full credit resumes only past roughly `R_NEW` plus two sigma — about 40-45 m in urban conditions, less in open sky. Between 30 and about 40 m, crediting is *partial and permanent*: noise pushes a fraction of samples into the dead zone, and the short NEW fragments left between them fall below `L_MIN` and are tombstoned (roughly half credit at 33 m with sigma 8). Deterministic under-crediting. | acceptable |
| A4 | Separated bike path 5-10 m from the road | Merged with the road. That separation is under two sigma of GPS error; no point-wise method can honestly separate it. | acceptable |
| A5 | 25 laps of a 400 m track | Lap 1 mints about 400 m of sites. Laps 2-25 match them (400 m apart along-track, far outside the guard; lane changes stay inside 20 m). Total about 400-460 m, visit count 1 for that activity. A low unique ratio here is a correct result, not an error. | pass |
| A6 | Switchbacks with legs 10-20 m apart | Anti-parallel legs are identical modulo 180, so bearing cannot separate them. The same-activity altitude gate rescues climbs recorded with a barometer, but only over the part of each leg where the vertical difference from its neighbour exceeds 10 m — legs converge in altitude near their shared turn, so the stretch approaching every turn merges regardless. Shallow switchbacks and GPS-only altitude merge outright. **This is a genuine limitation of every geometry-only method** and is stated as such in the UI. | fail |
| A7 | Teleport: paused watch during a drive, tunnel, dropout | Any chord above 60 m, gap above 60 s, or speed above the sport cap splits the leg. The jump is never resampled, interpolated, or credited. Split rather than delete, so the jump cannot relocate. | pass |
| A8 | Standing still for 10 minutes, points scattering in a 20 m blob | The window collapses to a single point: every point of a 20 m-wide blob stays within `STATION_D` = 24 m of any anchor inside it, and 10 minutes clears `STATION_S` = 90 s. If jitter throws points beyond `STATION_D` from the anchor, sub-windows collapse instead and the short-run rule bounds the residual, which stays bounded rather than growing with the duration of the stop. | pass |
| A9 | Part of a pass shifted 20-40 m by urban canyon | Up to about 25 m: absorbed by the dead zone, no phantom, and the pass still registers as visits. Note the absorption is not sharp -- at a 25 m offset with 4 m of noise, roughly a fifth of samples exceed 30 m and do earn credit, and by 30 m most of the pass does. 30-50 m localized excursions of 200 m or more: the offset detector reclassifies them. A uniform shift of the *whole* trace is deliberately not caught (see 5.4). | acceptable |
| A10 | Smart recording, points 15-40 m apart | Interpolated normally, since 60 m is the split threshold. Chord interpolation cuts sharp curves by a few metres, which stays inside `R_REP` so matching against denser history still works; a slight systematic under-credit on curvy sparse traces is documented. | pass |
| A11 | Crossing a road you have already covered | Both gates are bearing-filtered, so the cross street's sites are not candidates: about 0 m lost on a straight crossing. Turning onto or off a covered street rotates the bearing through compatibility for 10-20 m, which is small and only happens on turns. | pass |
| A12 | Treadmill, Zwift, manual entries | Excluded by flags first (`Virtual*`, `trainer`, `manual`, missing stream), because Zwift overlays real geography and geometry cannot catch it, plus the centroid backstop for a real GPS device that never moved. | pass |
| A13 | Both time-window semantics, interactively | Distinct ground comes from the fold over selected activities; new ground comes from `firstTsByGroup` compared against the window. Both are derived from data rather than processing order, both run in linear typed-array passes, and new ground can never exceed distinct ground. | pass |
| A14 | Small closed loop: a cul-de-sac bulb or tiny park loop | On a loop shorter than `GUARD_ALONG` every site of the current lap stays guard-hidden for the whole lap, so without the wrap-repeat rule (4.3.1) each lap would mint a spatially coincident copy of the last — same position, same bearing, invisible to the U-turn pass. With the rule, closure is caught and repeat laps cost nothing. Measured: a 40 m loop credits 28 m of 40, and a 94 m loop credits 52 m of 94. On the tightest loops most of the ring is credited because samples 8 m apart are 72 degrees apart in bearing and so cannot match each other; the shortfall is the closing stretch, which the wrap-repeat rule catches once the track has come most of the way round. At intermediate radii the far side emerges from behind the guard straight into the dead zone, so under-crediting is worst around a 100 m perimeter rather than at the smallest sizes. Bounded, one-time, deterministic. | acceptable |

Two further known artifacts, both bounded and both worth stating plainly:

- Credit is quantized at 8 m. Leg boundaries and privacy-zone truncations each cost or grant
  up to one quantum. Totals are honest to roughly 0.1 percent.
- Chronological attribution means that importing older history changes which activity *owns*
  the first-visit credit for shared ground. This is by design, and it is why per-activity
  "new ground" figures can shift after a backfill.

---

## 10. Test suite

`packages/ledger/src/__tests__/`. Write these before the implementation.

### 10.1 Synthetic track generator

A deterministic helper — **no `Math.random()`**; use a seeded PRNG such as mulberry32 so
failures reproduce exactly.

One property matters as much as determinism: the cross-track noise must be **autocorrelated**,
not resampled independently at every point. Real GPS error drifts over tens of seconds. Drawing
it independently every 4 m produces a sawtooth path no device ever records, and it wrecks the
bearing estimate, so every test ends up measuring an artifact of the fixture rather than the
algorithm. Use an AR(1) walk with a correlation length of about 25 m (`noiseCorrelationM`).

Every generator returns a `LedgerInput` (section 3.0) and accepts these common options in
addition to its own, so that any test can set them:

```ts
interface CommonSynthOptions {
  startTs: number;
  seed: number;
  sigmaM: number;          // Gaussian cross-track noise
  stepM: number;           // point spacing along the path
  speedMps: number;
  sportGroup?: number;     // default: foot
  sportType?: string;      // default: "Run"
  trainer?: boolean;       // default: false
  manual?: boolean;        // default: false
  withAltitude?: boolean;  // default: true where the generator produces elevation
  heavyTailFrac?: number;  // fraction of points drawn from heavyTailSigmaM instead of sigmaM
  heavyTailSigmaM?: number;
}

/** Escape hatch for geometries no named generator covers: build one directly from points. */
function fromPoints(opts: CommonSynthOptions & {
  points: Array<{ lat: number; lng: number; t: number; alt?: number }>;
}): LedgerInput;

type Opts<T> = CommonSynthOptions & T;

/** A straight road of `lengthM` metres on the given bearing, optionally offset sideways
 *  (`offsetM`) so two calls produce genuinely parallel roads a known distance apart. */
function straightRoad(o: Opts<{ lengthM: number; bearingDeg: number; offsetM?: number }>): LedgerInput;

/** The same road traversed out and back in one activity. */
function outAndBack(o: Opts<{ lengthM: number; bearingDeg: number }>): LedgerInput;

/** `laps` circuits of an oval of the given perimeter and lane offset. */
function trackLaps(o: Opts<{ laps: number; perimeterM: number; laneOffsetM: number }>): LedgerInput;

/** A stack of `legs` anti-parallel segments `spacingM` apart, each rising `riseM`. Set
 *  `withAltitude: false` to produce the A6b no-barometer variant. */
function switchbacks(o: Opts<{ legs: number; legLengthM: number; spacingM: number; riseM: number }>): LedgerInput;

/** A straight in, a 180-degree turn of the given radius, and a straight out. */
function hairpin(o: Opts<{ straightM: number; radiusM: number }>): LedgerInput;

/** `laps` circuits of a closed circle of the given perimeter. */
function closedLoop(o: Opts<{ perimeterM: number; laps: number }>): LedgerInput;

/** Two straight roads crossing at right angles, as one activity or two. */
function crossroads(o: Opts<{ lengthM: number }>): LedgerInput[];

/** A GPS trace that never leaves a small radius while reporting a large recorded distance --
 *  the treadmill shape the A12 backstop must catch. */
function treadmillShaped(o: Opts<{ radiusM: number; reportedDistanceM: number; durationS: number }>): LedgerInput;

/** Inserts a position jump of `jumpM` metres after `afterM` metres of travel. */
function withTeleport(base: LedgerInput, o: { afterM: number; jumpM: number; dtS: number }): LedgerInput;

/** Appends `durationS` of stationary jitter with the given scatter radius. */
function withStationaryBlob(base: LedgerInput, o: { durationS: number; radiusM: number; seed: number }): LedgerInput;

/** Shifts an entire activity sideways by `offsetM` metres. */
function withOffset(base: LedgerInput, offsetM: number): LedgerInput;

```

Assert on `uniqueMeters` and on per-sample label counts. Use tolerance bands, not exact
equality — the point is behavior, not a golden number.

### 10.2 Required cases

| Test | Setup | Assertion |
|---|---|---|
| A1 out-and-back | 2 km road out and back, sigma 4 m | `uniqueMeters` in [1950, 2100]. Explicitly **not** near 4000. |
| A1b no U-turn regression | Same, with `params.uTurnDedup` false | `uniqueMeters` in [1990, 2150], proving the pass removes roughly 10 m and is not doing something larger. |
| A1c turns spared | The A6 switchback stack (see A6 for the exact geometry), built twice with `params.uTurnDedup` true and false | `uniqueMeters` differs between the two runs by under 3 percent. Without the fold-back condition the difference is about 10 percent — each of the five turns loses the far half of its arc — so the test is not vacuous. This is the regression test for the fold-back condition in 5.3. Without it, the pass eats the turn regions, where adjacent legs are close together *and* at near-equal altitude, so the altitude gate cannot protect them. Read together with A1b — which asserts the pass *does* remove about 10 m on an out-and-back — the two pin the condition from both sides. A plain hairpin is deliberately not used: the pass is only tempted when the two straights are within `R_REP`, and at that separation they merge anyway (rows A4 and A6), so the geometry cannot distinguish a working condition from a broken one. |
| A2 repeat accretion | Same 3 km road, 100 activities, sigma 5 m, different seeds | Total `uniqueMeters` below 3400 (measured 3255, about 8.5 percent of envelope growth over 100 passes), and pass 100 alone adds **nothing** — convergence is the property that matters, not the absolute figure. Growth scales steeply with noise: 3.4 percent at sigma 3, 24 percent at sigma 8. |
| A2b heavy tail | As above at sigma 8, with 10 percent of the noise process drawn from sigma 18 m | Total below 4600. This is the test the short-run rule exists for. |
| A3 divided road | Two parallel roads 27 m apart, driven as separate activities | Second road contributes under 200 m of the 1 km (dead zone), and contributes zero phantom beyond its own length. |
| A3b partial band | Two genuinely distinct parallel roads 35 m apart, sigma 8 m, separate activities | Second road credits between 30 and 85 percent of its length (measured 64 percent), and a third pass over the same second road adds under 50 m — the shortfall is permanent, not recovered by repetition. |
| A4 parallel path | Two parallel lines 8 m apart | Second contributes under 100 m of 1 km. |
| A5 track laps | 25 laps of a 400 m oval, 1.2 m lane offset, sigma 3 m | `uniqueMeters` in [350, 520]. Measured 372, and identical to a single lap — laps 2 through 25 add exactly nothing. Explicitly not near 10000 and not near 0. |
| A6 switchbacks with altitude | **6 legs of 100 m, 15 m apart, 30 m rise per leg**, altitudes present, sigma 3 m. True length is 6 x 100 plus five semicircular turns of radius 7.5 m, about 718 m | `uniqueMeters` at least 80 percent of the true total (measured 83 percent). |
| A6b switchbacks without altitude | Identical geometry, altitudes stripped | Documented failure: `uniqueMeters` under 45 percent of the true total (measured 40 percent — only the first leg and the turns survive). **Assert the failure**, so a future change that fixes it fails this test loudly and gets reviewed. |
| A7 teleport | 2 km road, then a 5 km jump, then 2 km more | `uniqueMeters` in [3900, 4200]; the 5 km jump contributes nothing; exactly 2 legs. |
| A8 stationary | 1 km road plus 10 minutes of jitter scattering within a 10 m radius (20 m across, the size `STATION_D` is set for) | Jitter contributes under 60 m. |
| A9 offset absorbed | 2 km road, then a second pass with a 25 m **localized excursion** over 30 percent of its length, sigma 4 m | Second activity adds under 150 m. |
| A9b offset detected | Same, excursion 40 m, detector on | Second activity adds under 200 m (measured 0). |
| A9c offset detector off | Same geometry as A9b, detector off | Second activity adds more than 300 m (measured 520), confirming the flag actually gates the behavior. |
| A9d rigid shift not caught | 2 km road, then the same road shifted uniformly 40 m with no re-convergence, detector on | Second activity adds more than 1500 m. This asserts a **deliberate non-goal**: a uniform shift is indistinguishable from a new parallel road and must not be guessed away. |
| A10 sparse recording | Same road at 8 m and at 35 m spacing, as two activities | The sparse pass adds under 150 m of 2 km. |
| A11 crossing | An east-west road, then a north-south road crossing it | The second road credits at least 95 percent of its length. |
| A12 exclusions | Activities flagged `VirtualRun`, `trainer`, `manual`, and a treadmill-shaped GPS trace | All excluded; `uniqueMeters` is 0. |
| A13 semantics | Three activities across three years on partly-shared ground, run through a **reference implementation** of the fold and scan from `SPEC.md` section 3.4 that lives in the ledger test helpers | Distinct ground and new ground match a hand-computed table for six window and sport-filter combinations; new ground is never above distinct ground. Include a window whose bounds land exactly on activity start timestamps, to pin the inclusive-on-both-ends rule. The same reference implementation is reused in M5 as the oracle for the real query worker, so writing it here is not throwaway work. |
| A14 tiny loop | One lap of a 40 m closed loop, no noise | No two surviving sites lie within 2 m of each other with `angDiff360 <= 20` — the wrap-repeat rule prevents coincident duplicates — and `uniqueMeters` in [20, 40] (measured 28). |
| A14b small loop | One lap of a 94 m closed loop (radius about 15 m) | No coincident duplicates by the same test, and `uniqueMeters` in [40, 80]. |
| A14c repeated loop | Three laps of the same 40 m loop in one activity | `uniqueMeters` within 2 m of the single-lap A14 result. This is the assertion that actually pins the wrap-repeat rule; without it each lap re-mints a coincident copy. |
| Determinism | The same activity set, shuffled into a different order, built twice | The `sites`, `touches`, and `tracks` buffers are byte-identical and the `activities` arrays are deeply equal. The manifest is compared with `builtAt` excluded, since it is a wall-clock timestamp — it is the one field in the output that is deliberately not a function of the input. |
| Bearing math | Unit tests on `angDiff180` / `angDiff360` | Correct at 0, 45, 90, 135, 179, and across the wrap. |
| Credit sums | Resample a leg of known length | Credits sum to the leg length within 0.01 m. |

### 10.3 Real-data smoke check

Once real artifacts exist, `npm run stats` prints unique versus total mileage, site count,
label distribution, and the ten activities with the most new ground. Sanity checks that
catch broken builds quickly:

- Unique mileage must be well below total mileage for any real history (a typical athlete
  lands somewhere between 15 and 50 percent; measured 37.5 percent over a real 1,303-activity,
  10,595-mile history).
- At least one activity must credit above 90 percent, proving full credit is reachable.
  Do **not** assert that the chronologically first activity is nearly 100 percent new: a lap
  workout or a loop trail legitimately credits a fraction of its distance on its very first
  outing, and a real history opened with three laps of a 1.4-mile loop at 35 percent.
- No activity may credit more new ground than it travelled.
- A repeated commute route must show near-zero new ground after its first occurrence.
- The label distribution should be dominated by REPEAT for a mature history, with NONE near
  zero. (Samples whose sites the short-run rule removed surface as NONE in Pass II; there is
  no separate DROPPED label.)

---

## 11. Performance notes

Expected cost at the reference scale used throughout these documents — 3,000 activities,
roughly 3.5M resampled samples, roughly 1M sites — on an M-series Mac in Node. Budgets
elsewhere are sized with headroom to 1.4M sites:

| Stage | Cost |
|---|---|
| Preprocessing (dedup, median, split, collapse, resample) | 0.5-1.0 s |
| Pass I matching | 1.0-3.5 s |
| Tombstone passes | 0.2-0.5 s |
| Pass II attribution | 1.0-3.5 s |
| Compaction, per-group first-visit arrays, serialization | 0.5-1.0 s |
| **Total** | **well under the 30 s budget** |

Everything is linear, so a 5M-sample history costs about 1.7x. Implementation notes that
matter for hitting this:

- Use flat typed arrays and plain number keys. No object-per-point, no `BigInt`, no string keys.
- Grow the site table by doubling typed arrays, not by pushing to JavaScript arrays of objects.
- Keep the candidate loop branch-light: compute squared Mercator distance first and only
  apply `cosLat` and `Math.hypot` on survivors.
- If profiling shows the grid query dominating, the fix is a flat open-addressed typed-array
  hash rather than a `Map`. Do not reach for it before measuring.
