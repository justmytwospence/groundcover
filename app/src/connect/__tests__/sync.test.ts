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

import { activityIds, clearAll, STORE_CREDS, put } from '../../lib/db.js';
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
  body?: unknown;
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

    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      headers: new Headers({ ...RL_OK, ...(route.headers ?? {}) }),
      json: async () => route.body ?? {},
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

/** Pages of summaries, then a short page to end the crawl. */
function summaryRoutes(acts: FakeActivity[]): Route[] {
  return [
    { match: 'athlete/activities', body: acts.map(summaryJson), once: true },
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

    const p = await runSync({
      signal: ctrl.signal,
      onProgress: (prog) => {
        // Stop as soon as the first activity is on the wire.
        if (prog.phase === 'streams') ctrl.abort();
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
