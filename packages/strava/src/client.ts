/**
 * Stateless fetch wrapper over the Strava v3 API. Holds no token and no cursor: callers pass
 * an access token per request. See docs/data-pipeline.md section 3.3 for the rate-limit rules.
 *
 * The access token travels in the Authorization header and never in a URL or an error message.
 */

const API_BASE = 'https://www.strava.com/api/v3';

export interface RateLimit {
  /** Reads used in the current 15-minute window. */
  shortUsage: number;
  shortLimit: number;
  /** Reads used today. */
  dailyUsage: number;
  dailyLimit: number;
}

export class RateLimitError extends Error {
  readonly retryAfterMs?: number;
  readonly usage?: RateLimit;

  constructor(message: string, opts: { retryAfterMs?: number; usage?: RateLimit | null } = {}) {
    super(message);
    this.name = 'RateLimitError';
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
    if (opts.usage) this.usage = opts.usage;
  }
}

export class StravaHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'StravaHttpError';
    this.status = status;
  }
}

/** Strava sends both headers as a "short,daily" comma pair. */
function parsePair(value: string | null): [number, number] | null {
  if (value === null) return null;
  const parts = value.split(',');
  if (parts.length < 2) return null;
  const short = Number(parts[0].trim());
  const daily = Number(parts[1].trim());
  if (!Number.isFinite(short) || !Number.isFinite(daily)) return null;
  return [short, daily];
}

/**
 * Prefers the read-specific counters. Older responses (and some error paths) only carry the
 * combined X-RateLimit-* pair, which is close enough to steer pacing by.
 */
export function parseRateLimit(headers: Headers): RateLimit | null {
  const usage =
    parsePair(headers.get('x-readratelimit-usage')) ?? parsePair(headers.get('x-ratelimit-usage'));
  const limit =
    parsePair(headers.get('x-readratelimit-limit')) ?? parsePair(headers.get('x-ratelimit-limit'));
  if (!usage || !limit) return null;
  return {
    shortUsage: usage[0],
    dailyUsage: usage[1],
    shortLimit: limit[0],
    dailyLimit: limit[1],
  };
}

export interface StravaGetOptions {
  accessToken: string;
  query?: Record<string, string | number | boolean | undefined>;
}

export interface StravaGetResult<T> {
  data: T;
  rateLimit: RateLimit | null;
}

export async function stravaGet<T>(
  path: string,
  opts: StravaGetOptions,
): Promise<StravaGetResult<T>> {
  const url = new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: 'application/json' },
  });
  const rateLimit = parseRateLimit(res.headers);

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new RateLimitError(`Strava rate limit reached on GET ${path}`, {
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      usage: rateLimit,
    });
  }
  if (!res.ok) {
    throw new StravaHttpError(`Strava GET ${path} failed: HTTP ${res.status}`, res.status);
  }

  return { data: (await res.json()) as T, rateLimit };
}
