/**
 * The in-browser half of Strava OAuth.
 *
 * Strava's API sends `access-control-allow-origin: *` on both /oauth/token and /api/v3, so a
 * static site can run the authorization-code exchange and every subsequent call itself. There is
 * no server in this product and no proxy: the browser talks to Strava directly.
 */

import { authorizeUrl, exchangeCode, REQUIRED_SCOPE, type Creds } from '@um/strava';
import { loadCreds, saveTokens } from './creds.js';

const STATE_KEY = 'um.oauth.state';

/**
 * Strava matches the redirect against the "Authorization Callback Domain" on the user's own
 * app, which is a bare host with no scheme, port or path. Keeping the redirect at the site root
 * means the value they paste into Strava is exactly what we show them, with nothing to get
 * subtly wrong.
 */
export function redirectUri(): string {
  return `${window.location.origin}/`;
}

/** The host the user must paste into their Strava app settings. */
export function callbackDomain(): string {
  return window.location.hostname;
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Sends the browser to Strava. Does not return: the page is replaced. */
export async function beginAuthorization(): Promise<never> {
  const creds = await loadCreds();
  if (!creds) throw new Error('Add your Strava app credentials first.');
  const state = randomState();
  // sessionStorage, not localStorage: the value is meaningless once this tab's flow is over,
  // and it must not leak into other tabs that never started an authorization.
  sessionStorage.setItem(STATE_KEY, state);
  window.location.assign(authorizeUrl(creds.clientId, redirectUri(), state));
  return new Promise<never>(() => {});
}

export type CallbackResult =
  | { kind: 'none' }
  | { kind: 'connected'; athleteId?: number }
  | { kind: 'denied' }
  | { kind: 'error'; message: string };

/** Strips the OAuth parameters so a reload cannot replay a spent code. */
function cleanUrl(): void {
  const url = new URL(window.location.href);
  for (const p of ['code', 'state', 'scope', 'error']) url.searchParams.delete(p);
  window.history.replaceState(null, '', url.pathname + url.search + url.hash);
}

/**
 * Completes the flow if this page load is a redirect back from Strava.
 *
 * Returns `none` for an ordinary visit, which is the common case -- callers should treat it as
 * "nothing happened", not as a failure.
 */
export async function completeAuthorization(): Promise<CallbackResult> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');

  if (!code && !error) return { kind: 'none' };

  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  cleanUrl();

  if (error) return { kind: 'denied' };
  if (!expected || params.get('state') !== expected) {
    return { kind: 'error', message: 'That sign-in did not start from this tab. Please try again.' };
  }

  // Strava lets the user untick individual scopes on the consent screen. Without
  // activity:read_all, private activities are absent and privacy-zone GPS is trimmed, so the
  // map would be quietly incomplete -- a wrong answer is worse than a refusal to proceed.
  const granted = (params.get('scope') ?? '').split(',');
  if (!granted.includes(REQUIRED_SCOPE)) {
    return {
      kind: 'error',
      message:
        'The "View data about your private activities" permission was not granted. Without it ' +
        'Strava hides private activities and trims GPS inside your privacy zones, which would ' +
        'leave gaps in your map. Please authorize again and leave that box ticked.',
    };
  }

  const creds = await loadCreds();
  if (!creds) return { kind: 'error', message: 'Your app credentials are missing. Start again.' };

  try {
    const state = await exchangeCode(creds as Creds, code as string);
    await saveTokens(state);
    return { kind: 'connected', athleteId: state.athleteId };
  } catch {
    // exchangeCode never puts the response body in its message, and neither do we: the request
    // carried the client secret and the reply may echo it.
    return {
      kind: 'error',
      message:
        'Strava rejected the sign-in. The usual cause is a Client ID or Secret that does not ' +
        'match the app you authorized. Check both and try again.',
    };
  }
}
