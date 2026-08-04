/**
 * The sync state machine, against a stubbed fetch. Never the live Strava API: these must run
 * offline, deterministically, and without spending anybody's rate limit.
 *
 * What is worth testing here is not the happy path -- it is the three ways a long backfill ends
 * badly. Running out of daily budget, being told to slow down, and the tab being closed are all
 * expected events on a history that takes days to pull, and each has to leave storage in a state
 * the next run can pick up from.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activityIds, clearAll, STORE_ACTIVITIES, STORE_CREDS, count, put } from '../../lib/db.js';
import { etaMs, formatDuration, runSync } from '../sync.js';

const NOW = 1_700_000_000;

interface FakeActivity {
  id: number;
  startTs: number;
  sport?: string;
  trainer?: boolean;
  manual?: boolean;
  points?: number;
}

function summaryJson(a: FakeActivity) {
  return {
    id: a.id,
    name: `activity ${a.id}`,
    sport_type: a.sport ?? 'Run',
    type: a.sport ?? 'Run',
    start_date: new Date(a.startTs * 1000).toISOString(),
    start_date_local: new Date(a.startTs * 1000).toISOString(),
    distance: 5000,
    moving_time: 1800,
    elapsed_time: 1800,
    trainer: a.trainer ?? false,
    manual: a.manual ?? false,
    has_heartrate: false,
    start_latlng: [40, -105],
    map: { summary_polyline: null },
  };
}

function streamJson(points: number) {
  const latlng: Array<[number, number]> = [];
  const time: number[] = [];
  for (let i = 0; i < points; i++) {
    latlng.push([40 + i * 1e-4, -105 + i * 1e-4]);
    time.push(i * 5);
  }
  return { latlng: { data: latlng }, time: { data: time } };
}

const RL_OK = {
  'x-readratelimit-usage': '5,100',
  'x-readratelimit-limit': '100,1000',
};

interface Route {
  /** Matched against the request URL with includes(). */
  match: string;
  status?: number;
  headers?: Record<string, string>;
  /** A function receives the request URL, so a route can model server-side filtering. */
  body?: unknown | ((url: string) => unknown);
  /** Consumed once, then the next matching route takes over. */
  once?: boolean;
}

/**
 * A fetch stub driven by an ordered route list. Deliberately not a full server: a test that has
 * to model Strava faithfully stops testing our state machine and starts testing the model.
 */
function stubFetch(routes: Route[]) {
  const calls: string[] = [];
  const remaining = [...routes];

  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const i = remaining.findIndex((r) => url.includes(r.match));
    if (i === -1) throw new Error(`no stub route for ${url}`);
    const route = remaining[i];
    if (route.once) remaining.splice(i, 1);

    const body = typeof route.body === 'function'
      ? (route.body as (u: string) => unknown)(url)
      : route.body;

    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      headers: new Headers({ ...RL_OK, ...(route.headers ?? {}) }),
      json: async () => body ?? {},
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', impl);
  return { calls };
}

/** A token that is already valid, so no test hits the refresh endpoint unless it means to. */
async function seedCredentials(): Promise<void> {
  await put(STORE_CREDS, { k: 'app', v: { clientId: '1', clientSecret: 'x'.repeat(40) } });
  await put(STORE_CREDS, {
    k: 'token',
    v: {
      refreshToken: 'refresh-1',
      accessToken: 'access-1',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
  });
}

/**
 * Pages of summaries, then a short page to end the crawl.
 *
 * Honours `after` exactly as Strava does -- filtering on start_date, server-side. Without this
 * the stub hands back every activity no matter what the client asked for, and any test about
 * which activities a crawl can and cannot see is testing nothing. That is not hypothetical: a
 * regression test written against the naive stub passed against the very bug it was added for.
 */
function summaryRoutes(acts: FakeActivity[]): Route[] {
  const visible = (url: string) => {
    const after = Number(new URL(url).searchParams.get('after'));
    const list = Number.isFinite(after) && after > 0 ? acts.filter((a) => a.startTs > after) : acts;
    return list.map(summaryJson);
  };
  return [
    { match: 'athlete/activities', body: visible, once: true },
    { match: 'athlete/activities', body: [] },
  ];
}

describe('sync', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await clearAll();
    await seedCredentials();
  });

  it('stores activities that have GPS and skips ones that do not', async () => {
    stubFetch([
      ...summaryRoutes([
        { id: 1, startTs: NOW },
        { id: 2, startTs: NOW - 86400 },
      ]),
      { match: '/activities/1/streams', body: streamJson(10), once: true },
      // key_by_type omits streams that do not exist, so no GPS arrives as an empty object.
      { match: '/activities/2/streams', body: {}, once: true },
    ]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    expect(p.phase).toBe('done');
    expect([...(await activityIds())]).toEqual([1]);
    expect(p.warnings.map((w) => w.activityId)).toEqual([2]);
  });

  it('fetches newest first, so a partial backfill leaves recent history usable', async () => {
    const { calls } = stubFetch([
      ...summaryRoutes([
        { id: 10, startTs: NOW - 86400 * 30 },
        { id: 20, startTs: NOW },
        { id: 30, startTs: NOW - 86400 },
      ]),
      { match: '/streams', body: streamJson(6) },
    ]);

    await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    const order = calls
      .filter((u) => u.includes('/streams'))
      .map((u) => Number(/activities\/(\d+)\/streams/.exec(u)![1]));
    expect(order).toEqual([20, 30, 10]);
  });

  it('never spends a request on activities it can rule out from the summary alone', async () => {
    const { calls } = stubFetch([
      ...summaryRoutes([
        { id: 1, startTs: NOW, trainer: true },
        { id: 2, startTs: NOW - 10, manual: true },
        { id: 3, startTs: NOW - 20, sport: 'VirtualRide' },
        { id: 4, startTs: NOW - 30 },
      ]),
      { match: '/streams', body: streamJson(6) },
    ]);

    await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    const fetched = calls.filter((u) => u.includes('/streams'));
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain('/activities/4/streams');
  });

  it('stops cleanly when the daily budget is gone, and reports what is left', async () => {
    stubFetch([
      ...summaryRoutes([
        { id: 1, startTs: NOW },
        { id: 2, startTs: NOW - 10 },
        { id: 3, startTs: NOW - 20 },
      ]),
      { match: '/activities/1/streams', body: streamJson(6), once: true },
      {
        match: '/streams',
        status: 429,
        headers: { 'x-readratelimit-usage': '20,1000', 'x-readratelimit-limit': '100,1000' },
      },
    ]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    expect(p.phase).toBe('out-of-budget');
    expect(p.remaining).toBeGreaterThan(0);
    // The one that succeeded before the wall must still be stored: that is the whole point of
    // writing as we go rather than at the end.
    expect([...(await activityIds())]).toEqual([1]);
  });

  it('resumes without refetching what is already stored', async () => {
    const acts: FakeActivity[] = [
      { id: 1, startTs: NOW },
      { id: 2, startTs: NOW - 10 },
    ];
    stubFetch([...summaryRoutes(acts), { match: '/streams', body: streamJson(6) }]);
    await runSync({ signal: new AbortController().signal, onProgress: () => {} });
    expect((await activityIds()).size).toBe(2);

    // Second run: same account, nothing new.
    const { calls } = stubFetch([...summaryRoutes(acts), { match: '/streams', body: streamJson(6) }]);
    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    expect(p.phase).toBe('done');
    expect(calls.filter((u) => u.includes('/streams'))).toHaveLength(0);
  });

  it('keeps everything fetched so far when the caller aborts mid-run', async () => {
    const ctrl = new AbortController();
    stubFetch([
      ...summaryRoutes([
        { id: 1, startTs: NOW },
        { id: 2, startTs: NOW - 10 },
        { id: 3, startTs: NOW - 20 },
      ]),
      { match: '/streams', body: streamJson(6) },
    ]);

    let streamsSeen = 0;
    const p = await runSync({
      signal: ctrl.signal,
      onProgress: (prog) => {
        // Stop once the first activity has been fetched and the second is starting, so there is
        // genuinely something buffered for the abort path to preserve.
        if (prog.phase === 'streams' && ++streamsSeen === 2) ctrl.abort();
      },
    });

    expect(p.phase).toBe('stopped');
    expect((await activityIds()).size).toBeGreaterThanOrEqual(1);
    expect((await activityIds()).size).toBeLessThan(3);
  });

  it('reports an error rather than throwing when Strava rejects the token', async () => {
    stubFetch([{ match: 'athlete/activities', status: 401 }]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    expect(p.phase).toBe('error');
    expect(p.message).toBeTruthy();
    // The token value must never reach a message a user or a log could see.
    expect(p.message).not.toContain('access-1');
    expect(p.message).not.toContain('refresh-1');
  });
});

/**
 * Regressions for defects an adversarial review found in the first version of this engine.
 * Each of these shipped, and each was reproduced before being fixed -- so each test here is
 * known to fail against the code it replaced.
 */
describe('sync regressions', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await clearAll();
    await seedCredentials();
  });

  it('retries the activity a 429 interrupted, rather than skipping past it', async () => {
    const { calls } = stubFetch([
      ...summaryRoutes([{ id: 1, startTs: NOW }, { id: 2, startTs: NOW - 10 }]),
      // One transient 429 on activity 1, carrying headroom so it is not daily exhaustion.
      {
        match: '/activities/1/streams',
        status: 429,
        headers: { 'retry-after': '1', 'x-readratelimit-usage': '20,100' },
        once: true,
      },
      { match: '/streams', body: streamJson(6) },
    ]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    // The bug advanced the for-of iterator, so activity 1 was requested once and dropped
    // without a status, a warning, or any signal at all.
    const ids = calls
      .filter((u) => u.includes('/streams'))
      .map((u) => Number(/activities\/(\d+)\/streams/.exec(u)![1]));
    expect(ids.filter((n) => n === 1).length).toBe(2);
    expect([...(await activityIds())].sort()).toEqual([1, 2]);
    expect(p.phase).toBe('done');
  });

  it('refreshes an access token that expires mid-run instead of 401ing the rest', async () => {
    // A token already past the refresh margin, so the first request must re-mint.
    await put(STORE_CREDS, {
      k: 'token',
      v: { refreshToken: 'refresh-1', accessToken: 'stale', expiresAt: Math.floor(Date.now() / 1000) + 10 },
    });

    const { calls } = stubFetch([
      { match: 'oauth/token', body: { access_token: 'fresh', refresh_token: 'refresh-2', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      ...summaryRoutes([{ id: 1, startTs: NOW }, { id: 2, startTs: NOW - 10 }]),
      { match: '/streams', body: streamJson(6) },
    ]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    // The bug hoisted one token outside the loop and never refreshed, so a resumed backfill
    // 401ed every remaining activity and still reported "Sync complete".
    expect(calls.some((u) => u.includes('oauth/token'))).toBe(true);
    expect(p.phase).toBe('done');
    expect((await activityIds()).size).toBe(2);
  });

  it('recovers from a 401 by re-minting once, and gives up cleanly on a second', async () => {
    const { calls } = stubFetch([
      ...summaryRoutes([{ id: 1, startTs: NOW }]),
      { match: 'oauth/token', body: { access_token: 'fresh', refresh_token: 'refresh-2', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      { match: '/streams', status: 401 },
    ]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    // Exactly one forced re-mint, then a distinct terminal state -- not a generic error, and
    // not a cascade of failures across every remaining activity.
    expect(calls.filter((u) => u.includes('oauth/token'))).toHaveLength(1);
    expect(p.phase).toBe('needs-auth');
  });

  it('finds an activity uploaded late with an older start date', async () => {
    const first = { id: 1, startTs: NOW };
    stubFetch([...summaryRoutes([first]), { match: '/streams', body: streamJson(6) }]);
    await runSync({ signal: new AbortController().signal, onProgress: () => {} });
    expect([...(await activityIds())]).toEqual([1]);

    // A hike from three weeks ago, uploaded now. Strava filters `after` on start_date, so a
    // crawl narrowed to "newer than the newest we know" would never list it again.
    const late = { id: 2, startTs: NOW - 86400 * 21 };
    stubFetch([
      ...summaryRoutes([first, late]),
      { match: '/streams', body: streamJson(6) },
    ]);
    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    expect([...(await activityIds())].sort()).toEqual([1, 2]);
    expect(p.phase).toBe('done');
  });

  it('reports being out of daily budget when the summaries crawl hits the cap', async () => {
    stubFetch([
      {
        match: 'athlete/activities',
        status: 429,
        headers: { 'x-readratelimit-usage': '20,1000', 'x-readratelimit-limit': '100,1000' },
      },
    ]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    // The bug slept through three full 15-minute windows and then reported a raw error, even
    // though a daily cap cannot clear until tomorrow.
    expect(p.phase).toBe('out-of-budget');
    expect(p.message).toMatch(/tomorrow/i);
  });

  it('does not claim "Sync complete" when activities failed to download', async () => {
    stubFetch([
      ...summaryRoutes([{ id: 1, startTs: NOW }, { id: 2, startTs: NOW - 10 }]),
      { match: '/activities/1/streams', body: streamJson(6), once: true },
      { match: '/streams', status: 500 },
    ]);

    const p = await runSync({ signal: new AbortController().signal, onProgress: () => {} });

    expect(p.phase).toBe('done');
    expect(p.message).not.toMatch(/^Sync complete/);
    expect(p.message).toMatch(/could not be downloaded/i);
  });

  it('has finished all its writes by the time it resolves, so an erase cannot race it', async () => {
    const ctrl = new AbortController();
    stubFetch([
      ...summaryRoutes([
        { id: 1, startTs: NOW },
        { id: 2, startTs: NOW - 10 },
        { id: 3, startTs: NOW - 20 },
      ]),
      { match: '/streams', body: streamJson(6) },
    ]);

    const run = runSync({
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.phase === 'streams') ctrl.abort();
      },
    });

    // Exactly what disconnect() now does: abort, WAIT for it to stop, then erase. Previously
    // the erase was issued while the sync's final flush was still queued, and IndexedDB
    // serialised that write after the clear -- so GPS survived an erase the UI had promised.
    await run;
    await clearAll();

    expect(await count(STORE_ACTIVITIES)).toBe(0);
    expect([...(await activityIds())]).toEqual([]);
  });
});

describe('eta', () => {
  it('is pure pacing while the current window has room', () => {
    const rl = { shortUsage: 0, shortLimit: 100, dailyUsage: 0, dailyLimit: 1000 };
    expect(etaMs(10, rl)).toBe(10 * 300);
  });

  it('accounts for whole windows once the remaining work exceeds this window', () => {
    const rl = { shortUsage: 100, shortLimit: 100, dailyUsage: 0, dailyLimit: 1000 };
    // No headroom now, so 250 more reads is this window plus two more.
    expect(etaMs(250, rl)).toBeGreaterThan(2 * 15 * 60 * 1000);
  });

  it('is zero when there is nothing left', () => {
    expect(etaMs(0, null)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('drops to the two largest useful units', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(9 * 60_000)).toBe('9m');
    expect(formatDuration(3 * 3_600_000 + 25 * 60_000)).toBe('3h 25m');
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000)).toBe('2d 3h');
  });
});
