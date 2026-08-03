import { afterEach, describe, expect, it, vi } from 'vitest';

import { RateLimitError, StravaHttpError, parseRateLimit, stravaGet } from '../client.js';
import { StreamSetSchema, SummaryActivitySchema } from '../types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Never hits the network: every test stubs fetch with a canned Response. */
function stubFetch(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('parseRateLimit', () => {
  it('parses the read-specific "a,b" pairs', () => {
    const headers = new Headers({
      'X-ReadRateLimit-Usage': '17,432',
      'X-ReadRateLimit-Limit': '200,2000',
    });
    expect(parseRateLimit(headers)).toEqual({
      shortUsage: 17,
      shortLimit: 200,
      dailyUsage: 432,
      dailyLimit: 2000,
    });
  });

  it('falls back to X-RateLimit-* when the read-specific headers are absent', () => {
    const headers = new Headers({
      'X-RateLimit-Usage': '3, 91',
      'X-RateLimit-Limit': '100, 1000',
    });
    expect(parseRateLimit(headers)).toEqual({
      shortUsage: 3,
      shortLimit: 100,
      dailyUsage: 91,
      dailyLimit: 1000,
    });
  });

  it('returns null when a header is missing or malformed', () => {
    expect(parseRateLimit(new Headers())).toBeNull();
    expect(parseRateLimit(new Headers({ 'X-ReadRateLimit-Usage': '17,432' }))).toBeNull();
    expect(
      parseRateLimit(
        new Headers({ 'X-ReadRateLimit-Usage': 'nope', 'X-ReadRateLimit-Limit': '200,2000' }),
      ),
    ).toBeNull();
  });
});

describe('stravaGet', () => {
  it('sends the token in the Authorization header and the query in the URL', async () => {
    const fetchMock = stubFetch([{ id: 1 }], {
      headers: { 'X-ReadRateLimit-Usage': '1,1', 'X-ReadRateLimit-Limit': '200,2000' },
    });

    const { data, rateLimit } = await stravaGet<Array<{ id: number }>>('/athlete/activities', {
      accessToken: 'tok',
      query: { per_page: 200, page: 1, after: undefined },
    });

    expect(data).toEqual([{ id: 1 }]);
    expect(rateLimit).toEqual({ shortUsage: 1, shortLimit: 200, dailyUsage: 1, dailyLimit: 2000 });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.strava.com/api/v3/athlete/activities?per_page=200&page=1');
    expect(url).not.toContain('tok');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('throws RateLimitError with retryAfterMs and usage on 429', async () => {
    stubFetch(
      { message: 'Rate Limit Exceeded' },
      {
        status: 429,
        headers: {
          'Retry-After': '42',
          'X-ReadRateLimit-Usage': '200,900',
          'X-ReadRateLimit-Limit': '200,2000',
        },
      },
    );

    const err = await stravaGet('/activities/1/streams', { accessToken: 'tok' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitError);
    const rateErr = err as RateLimitError;
    expect(rateErr.retryAfterMs).toBe(42_000);
    expect(rateErr.usage?.shortUsage).toBe(200);
    expect(rateErr.usage?.dailyLimit).toBe(2000);
    expect(rateErr.message).not.toContain('tok');
  });

  it('leaves retryAfterMs undefined when Retry-After is absent', async () => {
    stubFetch({}, { status: 429 });
    const err = await stravaGet('/activities/1/streams', { accessToken: 'tok' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBeUndefined();
  });

  it('throws StravaHttpError carrying the status on 500', async () => {
    stubFetch({ message: 'oops' }, { status: 500 });
    const err = await stravaGet('/activities/1/streams', { accessToken: 'tok' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StravaHttpError);
    expect((err as StravaHttpError).status).toBe(500);
    expect((err as Error).message).not.toContain('tok');
  });

  it('throws StravaHttpError with status 404 for an activity with no streams', async () => {
    stubFetch({ message: 'Resource Not Found' }, { status: 404 });
    const err = await stravaGet('/activities/1/streams', { accessToken: 'tok' }).catch(
      (e: unknown) => e,
    );
    expect((err as StravaHttpError).status).toBe(404);
  });
});

describe('wire schemas', () => {
  it('accepts a StreamSet that omits latlng entirely', () => {
    const parsed = StreamSetSchema.parse({
      time: { data: [0, 1, 2], series_type: 'distance', original_size: 3, resolution: 'high' },
      heartrate: { data: [120, 121, 122] },
    });
    expect(parsed.latlng).toBeUndefined();
    expect(parsed.time?.data).toEqual([0, 1, 2]);
  });

  it('accepts an entirely empty StreamSet', () => {
    expect(StreamSetSchema.parse({})).toEqual({});
  });

  it('parses a full StreamSet and keeps latlng pairs typed', () => {
    const parsed = StreamSetSchema.parse({
      latlng: { data: [[37.7749, -122.4194]], series_type: 'distance' },
      time: { data: [0] },
      altitude: { data: [12.4] },
    });
    expect(parsed.latlng?.data[0]).toEqual([37.7749, -122.4194]);
    expect(parsed.altitude?.data).toEqual([12.4]);
  });

  it('keeps unknown SummaryActivity keys instead of throwing', () => {
    const parsed = SummaryActivitySchema.parse({
      id: 12345678901,
      name: 'Morning Run',
      sport_type: 'Run',
      start_date: '2026-07-14T13:02:11Z',
      start_date_local: '2026-07-14T06:02:11Z',
      distance: 12873.4,
      trainer: false,
      manual: false,
      start_latlng: [37.77, -122.42],
      map: { id: 'a1', summary_polyline: 'abc', resource_state: 2 },
      some_field_strava_added_last_week: 7,
    });
    expect(parsed.map?.summary_polyline).toBe('abc');
    expect((parsed as Record<string, unknown>).some_field_strava_added_last_week).toBe(7);
  });

  it('accepts a no-GPS summary whose start_latlng is empty or null', () => {
    const base = {
      id: 1,
      name: 'Treadmill',
      sport_type: 'Run',
      start_date: '2026-07-14T13:02:11Z',
      start_date_local: '2026-07-14T06:02:11Z',
      distance: 5000,
      trainer: true,
      manual: false,
    };
    expect(SummaryActivitySchema.parse({ ...base, start_latlng: [] }).start_latlng).toEqual([]);
    expect(SummaryActivitySchema.parse({ ...base, start_latlng: null }).start_latlng).toBeNull();
    expect(SummaryActivitySchema.parse(base).start_latlng).toBeUndefined();
  });
});
