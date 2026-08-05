/**
 * The paste-the-address path.
 *
 * This exists because Strava allows exactly one Authorization Callback Domain per application,
 * and most people's is already spoken for by something else. It works because Strava checks the
 * redirect only when issuing the code -- the token exchange sends client_id, client_secret,
 * grant_type and code, and never a redirect URI. So the redirect only has to land somewhere the
 * user can read a URL; it does not have to land on us.
 */

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAll, put, STORE_CREDS } from '../../lib/db.js';
import { loadTokens } from '../creds.js';
import { completeFromPastedUrl, redirectUriFor } from '../oauth.js';

const TOKEN_OK = {
  access_token: 'access-x',
  refresh_token: 'refresh-x',
  expires_at: 2_000_000_000,
  athlete: { id: 99 },
};

function stubToken(body: unknown, status = 200) {
  const calls: Array<Record<string, string>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(Object.fromEntries(new URLSearchParams(String(init?.body ?? ''))));
      return {
        ok: status < 400,
        status,
        headers: new Headers(),
        json: async () => body,
      } as unknown as Response;
    }),
  );
  return calls;
}

async function seedApp(callbackDomain = 'localhost') {
  await put(STORE_CREDS, {
    k: 'app',
    v: { clientId: '4242', clientSecret: 'y'.repeat(40), callbackDomain },
  });
}

const OK_URL =
  'http://localhost/?state=abc&code=THECODE&scope=read,activity:read_all';

describe('redirectUriFor', () => {
  it('uses http for loopback, where nothing is listening to terminate TLS', () => {
    expect(redirectUriFor('localhost')).toBe('http://localhost/');
    expect(redirectUriFor('127.0.0.1')).toBe('http://127.0.0.1/');
  });

  it('uses https for a real host', () => {
    expect(redirectUriFor('groundcover.vercel.app')).toBe('https://groundcover.vercel.app/');
  });
});

describe('completeFromPastedUrl', () => {
  beforeEach(async () => {
    vi.unstubAllGlobals();
    await clearAll();
    await seedApp();
    sessionStorage.clear();
  });

  it('exchanges a pasted redirect and stores the tokens', async () => {
    const calls = stubToken(TOKEN_OK);
    const res = await completeFromPastedUrl(OK_URL);

    expect(res.kind).toBe('connected');
    expect((await loadTokens())?.refreshToken).toBe('refresh-x');
    // The whole premise: no redirect_uri is sent, which is why the callback domain is irrelevant
    // by this point.
    expect(calls[0]).not.toHaveProperty('redirect_uri');
    expect(calls[0].grant_type).toBe('authorization_code');
    expect(calls[0].code).toBe('THECODE');
  });

  it('accepts a bare query string or a bare code, not just a whole URL', async () => {
    stubToken(TOKEN_OK);
    expect((await completeFromPastedUrl('?code=THECODE&scope=activity:read_all')).kind).toBe(
      'connected',
    );

    await clearAll();
    await seedApp();
    stubToken(TOKEN_OK);
    expect((await completeFromPastedUrl('  THECODE  ')).kind).toBe('connected');
  });

  it('refuses an address carrying no code, and says what to look for', async () => {
    stubToken(TOKEN_OK);
    const res = await completeFromPastedUrl('http://localhost/');
    expect(res.kind).toBe('error');
    expect(res.kind === 'error' && res.message).toMatch(/authorization code/i);
  });

  it('reports a declined authorization as declined rather than an error', async () => {
    stubToken(TOKEN_OK);
    expect((await completeFromPastedUrl('http://localhost/?error=access_denied')).kind).toBe(
      'denied',
    );
  });

  it('rejects a paste from a different attempt when this tab started one', async () => {
    sessionStorage.setItem('um.oauth.state', 'the-real-one');
    stubToken(TOKEN_OK);

    const res = await completeFromPastedUrl(OK_URL); // carries state=abc
    expect(res.kind).toBe('error');
    expect(res.kind === 'error' && res.message).toMatch(/different sign-in/i);
    expect(await loadTokens()).toBeNull();
  });

  it('accepts a paste when this tab has no stored state, since the user authorized elsewhere', async () => {
    stubToken(TOKEN_OK);
    // No sessionStorage entry: they may have started the flow in another window entirely.
    // Requiring a match here would break the legitimate case, and a deliberate paste is not the
    // threat a state parameter defends against.
    expect((await completeFromPastedUrl(OK_URL)).kind).toBe('connected');
  });

  it('refuses when the private-activity scope was unticked', async () => {
    stubToken(TOKEN_OK);
    const res = await completeFromPastedUrl('http://localhost/?code=X&scope=read');
    expect(res.kind).toBe('error');
    expect(res.kind === 'error' && res.message).toMatch(/private activities/i);
    expect(await loadTokens()).toBeNull();
  });

  it('never puts a credential in the message when Strava rejects the code', async () => {
    stubToken({ message: 'Bad Request' }, 400);
    const res = await completeFromPastedUrl(OK_URL);

    expect(res.kind).toBe('error');
    const msg = res.kind === 'error' ? res.message : '';
    expect(msg).not.toContain('y'.repeat(40));
    expect(msg).not.toContain('THECODE');
    expect(msg).toMatch(/single-use/i);
  });
});
