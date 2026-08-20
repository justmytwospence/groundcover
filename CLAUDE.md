# GroundCover

Personal Strava heatmap that computes deduplicated ("unique") mileage. Read `SPEC.md` first,
then `docs/build-plan.md`. This file carries only what those documents cannot tell you.

## Credentials

- `.env.local` holds `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`. `.strava-token.json` holds
  the rotating refresh token. Both are gitignored. **Never print, log, or echo a token value.**
- Strava allows one API application per account. If yours is already used by another tool,
  this project still holds its **own** refresh token in its own `.strava-token.json` and never
  reads or writes any other store: Strava rotates the refresh token on every refresh, so two
  consumers sharing one copy invalidate each other. See `docs/data-pipeline.md` section 1.2.
- Rate limits belong to the *application*, so anything else on the same registration shares the
  budget. Overlapping runs make both see 429s; both retry, so it degrades rather than breaks.
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

### The publish deployment

A second deployment serving **the owner's own map, read only, in public**. See `SPEC.md`
section 4.6. It runs entirely in the cloud: a daily Vercel cron rebuilds and republishes, so
nothing depends on this laptop.

Live at **https://groundcover-spencer.vercel.app**, project `groundcover-spencer`.

```bash
npm run publish:provision # ONE TIME. creates + connects both blob stores
npm run publish:seed      # ONE TIME. data/ + refresh token -> the private blob store
npm run publish:refresh   # run one refresh from here; prints PUBLISH_POINTER_URL
npm run publish:deploy    # stage .local/publish/ and deploy it
```

- `.env.publish.local` (gitignored) is `vercel env pull`ed, plus two lines added by hand:
  `PUBLISH_POINTER_URL` and `PUBLISH_BYO_URL`. Re-pulling drops them; put them back.
- **`publish:seed` is a one-way door.** Strava allows one holder of the refresh token; after
  seeding, the cloud is it and `npm run sync` here will start failing. Getting it back means
  `npm run auth` plus a re-seed, which locks the cloud out instead.
- `.local/publish/.vercel/` holds the link to the publish project. `publish:stage` preserves it
  while clearing everything else; do not delete it or the next deploy targets the wrong project.
- The published map starts at **2023-01-01**. The cutoff is `MIN_START_TS` in
  `scripts/publish/refresh.ts` and applies to that deployment only; local builds and the BYO
  deployment keep the full history. Pre-cutoff activities are dropped, not carried as prior
  ground, so the two deployments legitimately report different unique mileage for the same
  ground. `current.json` records the cutoff, so changing it forces a rebuild on the next run.
- Never point the publish project at the BYO project (`groundcovermap`) or share stores between
  them. They have deliberately opposite CSPs.

#### Deploying after a code change

Both deployments are automatic on push to `main`, by two different mechanisms:

- **`groundcovermap`** is git-connected to this repository. Vercel builds it directly.
- **`groundcover-spencer`** cannot be — it deploys from the gitignored `.local/publish/` — so
  `.github/workflows/publish.yml` stages and deploys it with the Vercel CLI.

**The nightly cron refreshes data, never code.** `api/refresh.js` embeds a bundled snapshot of
`packages/ledger` taken at stage time. Without a redeploy, an algorithm change would go live on
the BYO site while the published map kept rebuilding nightly with the old code, indefinitely and
silently. That is the whole reason the workflow exists; do not delete it and rely on the cron.

CI holds three secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`. The token is
**scoped to the `groundcover-spencer` project** and cannot touch the BYO deployment — verified:
it reads that project (200) and gets 404 on `groundcovermap`. The private blob store's token is
deliberately absent; CI builds and deploys, it never reads anyone's GPS. Rotate by creating a new
project-scoped token in the dashboard and `gh secret set VERCEL_TOKEN`.

**Deployment goes through the REST API (`scripts/publish/deploy.ts`), not `vercel deploy`.** The
CLI calls `GET /v2/user` on startup, which a project-scoped `vcp_` token answers with 404, so
every CLI command dies at `Error: User not found.` before reaching a deployment — the CLI only
works with a token that can act on the whole account. Deploying through the API is what lets the
token stay scoped. `scripts/publish/ci-token.ts` (which mints a scoped token via the API) is kept
for rotation, but note Vercel refuses token creation from both the CLI's OAuth session and from
project-scoped tokens, so it needs an account-scoped throwaway to run.

#### Four traps, all of which fail silently

Each of these cost real debugging time and none announced itself.

1. **`vercel blob store add` only creates PUBLIC stores.** No flag, no prompt, no warning --
   including when you name the store "groundcover-private". Only the REST API takes
   `access: 'private'`, which is why `publish:provision` exists. Access cannot be changed after
   creation. Verify with `list` and check the `access` field; do not trust the name.
2. **Deleting a blob token env var REVOKES that token.** So you cannot connect a store, copy
   `BLOB_READ_WRITE_TOKEN`, rename it, and delete the original -- the copy authenticates against
   nothing and every later call fails with "Access denied" far from the cause. Pass
   `envVarPrefix` on the connection instead, which is what mints the name in the first place.
3. **`vercel env add` swallows the trailing newline as part of the value.** Piping `secret\n`
   stores `secret\n`, and the only symptom is a downstream HTTP 401 from a third party. Write the
   value with no trailing newline.
4. **The refresh function cannot be fully bundled.** `@vercel/blob` pulls in `jose`, which does a
   dynamic `require('node:buffer')` that esbuild cannot shim into ESM. The bundle imports fine
   locally and then dies at module load in production with a bare `FUNCTION_INVOCATION_FAILED`.
   It is externalised in `stage.ts` and pinned in the staged `package.json`; keep it that way.

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
- Map colors were validated with a palette checker, not chosen by eye. The checker is
  `npm run palette` (`scripts/palette-check.ts`); it reads `app/src/lib/theme.ts`, so change a
  value there and in `app/src/theme.css` together and re-run it rather than eyeballing.
  `npm run palette -- search` ranks candidate hues, `-- explain '#hex,#hex'` scores one
  candidate. Known deviations live in its `ALLOWANCES` table with a reason, not in a loosened
  threshold. See `SPEC.md` section 6.2.
