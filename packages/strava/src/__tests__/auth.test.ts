import { afterEach, describe, expect, it, vi } from 'vitest';

import { authorizeUrl, exchangeCode, mintAccessToken } from '../auth.js';

const CREDS = { clientId: '12345', clientSecret: 'shhh' };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Never hits the network: every test stubs fetch with a canned Response. */
function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('mintAccessToken', () => {
  it('flags a rotated refresh token so the caller persists it', async () => {
    stubFetch({ access_token: 'access-new', refresh_token: 'refresh-new', expires_at: 1785790000 });

    const minted = await mintAccessToken(CREDS, { refreshToken: 'refresh-old' });

    expect(minted.rotated).toBe(true);
    expect(minted.refreshToken).toBe('refresh-new');
    expect(minted.accessToken).toBe('access-new');
    expect(minted.expiresAt).toBe(1785790000);
  });

  it('reports rotated=false when Strava hands back the same refresh token', async () => {
    stubFetch({ access_token: 'access-new', refresh_token: 'refresh-old', expires_at: 1785790000 });

    const minted = await mintAccessToken(CREDS, { refreshToken: 'refresh-old' });

    expect(minted.rotated).toBe(false);
    expect(minted.refreshToken).toBe('refresh-old');
  });

  it('posts grant_type=refresh_token as form-encoded body, not query params', async () => {
    const fetchMock = stubFetch({
      access_token: 'a',
      refresh_token: 'b',
      expires_at: 1,
    });

    await mintAccessToken(CREDS, { refreshToken: 'refresh-old' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.strava.com/oauth/token');
    expect(url).not.toContain('shhh');
    expect(init.method).toBe('POST');

    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-old');
    expect(body.get('client_id')).toBe('12345');
  });

  it('throws with the status only, never the response body', async () => {
    stubFetch({ message: 'Bad Request', refresh_token: 'leaked-token' }, 400);

    const err = await mintAccessToken(CREDS, { refreshToken: 'refresh-old' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Strava token request failed: HTTP 400');
    expect((err as Error).message).not.toContain('leaked-token');
    expect((err as Error).message).not.toContain('shhh');
  });
});

describe('exchangeCode', () => {
  it('posts grant_type=authorization_code and returns the athlete id', async () => {
    const fetchMock = stubFetch({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: 1785790000,
      athlete: { id: 12345, username: 'someone' },
    });

    const token = await exchangeCode(CREDS, 'the-code');

    expect(token).toEqual({
      refreshToken: 'refresh',
      accessToken: 'access',
      expiresAt: 1785790000,
      athleteId: 12345,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
  });

  it('tolerates a response with no athlete object', async () => {
    stubFetch({ access_token: 'a', refresh_token: 'b', expires_at: 1 });
    const token = await exchangeCode(CREDS, 'the-code');
    expect(token.athleteId).toBeUndefined();
  });
});

describe('authorizeUrl', () => {
  it('requests activity:read_all with a forced approval prompt', () => {
    const url = new URL(authorizeUrl('12345', 'http://localhost:8721/callback'));

    expect(url.origin + url.pathname).toBe('https://www.strava.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('12345');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8721/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('approval_prompt')).toBe('force');
    expect(url.searchParams.get('scope')).toBe('activity:read_all');
  });
});
