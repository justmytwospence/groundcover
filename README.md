# GroundCover

**How much ground have you *actually* covered?**

Strava adds up every mile you log. It never tells you how much of the world those miles cover —
how much distinct road and trail your feet have genuinely been on, counting the loop you have run
two hundred times exactly once.

One real history: **10,639 miles logged → 3,975 miles of actual ground.**

GroundCover works that number out from your GPS and draws it. Ground covered once glows gold;
ground worn into a groove fades to blue. Scrub through time and watch your own map fill in, one
route drawing itself at a time.

→ **[groundcovermap.vercel.app](https://groundcovermap.vercel.app)**

## Your history never leaves your browser

There is no server, no account, and no database. Activities are downloaded straight from Strava to
your tab, and everything is computed and stored on your own machine. Nobody — including whoever
deployed it — can see your map.

That is enforced rather than promised:

- The `Content-Security-Policy` in `vercel.json` names Strava and the basemap in `connect-src` and
  nothing else, so a stray analytics snippet would be blocked by the browser rather than quietly
  shipping GPS off your machine.
- Built artifacts live in `.local/`, outside every directory `vite build` copies from, and
  `.vercelignore` names `data/` and `.local/` explicitly. Publishing someone's coordinates is
  structurally impossible rather than a habit.
- Tokens are never logged, printed, embedded in an error message, or put in a URL.

See `SPEC.md` §0 for the full invariant.

## The interesting part is the algorithm

Deduplicating GPS is harder than it looks. Two runs down the same street are never the same
coordinates; GPS wanders by ten metres and back. Naively snapping to a grid double-counts a road
crossed at an angle, and naively merging nearby points slowly eats an entire city.

`packages/ledger` resamples every activity to a point every 8 m and maintains an append-only table
of *sites* in chronological order. Within 20 m of an existing site with a compatible bearing is a
repeat; beyond 30 m is new ground; **20–30 m is a deliberate dead zone** — a hysteresis brake that
stops GPS jitter from slowly accreting phantom mileage.

Credit is chronological: whoever reached ground first gets it. That is why adding an old activity
rebuilds everything.

`docs/algorithm.md` specifies it in full, including the failure modes. The adversarial test suite
in `packages/ledger/src/__tests__/` **is the specification** — several tests deliberately assert
*documented failures*, so a change that alters them fails loudly and gets reviewed rather than
passing silently.

## Running it yourself

```bash
npm ci
npm run dev          # app at localhost:5173
npm test             # the algorithm's specification
```

The deployed app needs nothing else — visitors connect their own Strava account from the browser.

There is also a local pipeline, which remains the fastest personal workflow:

```bash
npm run auth         # one time, interactive
npm run sync         # crawl activities + GPS into data/ (resumable, slow on a first run)
npm run build:ledger # data/ -> .local/artifacts/
npm run stats        # smoke-check the build
```

## Why you bring your own Strava credentials

Strava counts rate limits **per application**, so one shared registration would run dry after a
handful of people and the ceiling would be permanent. Registering your own removes it — and means
this project holds no Strava relationship and nobody else's secrets.

Strava also allows exactly one Authorization Callback Domain per app, and most people's is already
spoken for. You do not have to change it: the token exchange never sees a redirect URI, so the
redirect only has to land somewhere you can read a URL. Leave it as `localhost`, copy the address
you land on, and paste it back. `docs/data-pipeline.md` explains why that works.

## Layout

| | |
|---|---|
| `packages/ledger` | the algorithm — pure TypeScript, no I/O, runs in Node or a browser worker |
| `packages/strava` | a thin, stateless Strava client that holds no credentials |
| `app` | the map, the query engine, and the in-browser sync |
| `scripts` | the local pipeline |
| `SPEC.md` | the master spec; read this first |

Not affiliated with Strava.
