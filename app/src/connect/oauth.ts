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
 * Where Strava will send the browser after the user approves.
 *
 * Strava checks this host against the one "Authorization Callback Domain" on the user's app, and
 * checks it ONLY here -- the token exchange takes client_id, client_secret, grant_type and code,
 * and never sees a redirect URI at all. That asymmetry is what makes the paste flow below
 * possible: the redirect has to land somewhere the user can read a URL, but it does not have to
 * land on us.
 *
 * http for loopback, since nothing is listening there to terminate TLS.
 */
export function redirectUriFor(domain: string): string {
  const loopback = domain === 'localhost' || domain === '127.0.0.1' || domain === '[::1]';
  return `${loopback ? 'http' : 'https'}://${domain}/`;
}

/** The host this app is being served from. */
export function currentHost(): string {
  return window.location.hostname;
}

/** True when Strava will land back on this very page, so the redirect can be handled for them. */
export function isSelfHosted(domain: string): boolean {
  return domain === currentHost();
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Starts the authorization.
 *
 * When the user's callback domain is this host, the browser is sent there and comes back here,
 * so the whole thing is invisible. When it is anything else -- and it usually is, because Strava
 * allows one per application and most people's is already spoken for -- Strava is opened in a
 * separate tab instead, so this page survives to receive the pasted result.
 *
 * Returns true when it took over the page, meaning the caller will not run again.
 */
export async function beginAuthorization(): Promise<boolean> {
  const creds = await loadCreds();
  if (!creds) throw new Error('Add your Strava app credentials first.');

  const state = randomState();
  // sessionStorage, not localStorage: the value is meaningless once this tab's flow is over,
  // and it must not leak into other tabs that never started an authorization.
  sessionStorage.setItem(STATE_KEY, state);

  const url = authorizeUrl(creds.clientId, redirectUriFor(creds.callbackDomain), state);

  if (isSelfHosted(creds.callbackDomain)) {
    window.location.assign(url);
    return true;
  }
  window.open(url, '_blank', 'noopener');
  return false;
}

/**
 * Finishes an authorization from a URL the user pasted.
 *
 * The universal path. Strava redirects to their callback domain, which is typically localhost
 * with nothing listening, so the browser shows a connection error and the authorization code
 * simply sits in the address bar -- transmitted to no one. They copy it here, and the exchange
 * happens directly against Strava, needing no redirect at all.
 */
export async function completeFromPastedUrl(pasted: string): Promise<CallbackResult> {
  const text = pasted.trim();
  if (!text) return { kind: 'error', message: 'Paste the address you were redirected to.' };

  let params: URLSearchParams;
  try {
    // Accept a full URL, a bare query string, or just the code on its own.
    if (/^https?:\/\//i.test(text)) params = new URL(text).searchParams;
    else if (text.includes('=')) params = new URLSearchParams(text.replace(/^\?/, ''));
    else params = new URLSearchParams({ code: text });
  } catch {
    return { kind: 'error', message: 'That does not look like a web address. Paste the whole thing.' };
  }

  if (params.get('error')) return { kind: 'denied' };

  const code = params.get('code');
  if (!code) {
    return {
      kind: 'error',
      message:
        'No authorization code in that address. Make sure you copied the whole thing, including ' +
        'everything after the question mark.',
    };
  }

  // The state check is best-effort here by design. It defends against a redirect this tab never
  // asked for, which cannot happen when a person deliberately pastes a value -- and requiring it
  // would break the legitimate case of authorizing in a window this tab knows nothing about. So
  // it is enforced when we have something to compare against, and skipped when we do not.
  const expected = sessionStorage.getItem(STATE_KEY);
  const got = params.get('state');
  if (expected && got && got !== expected) {
    return {
      kind: 'error',
      message: 'That address is from a different sign-in attempt. Start again and paste the new one.',
    };
  }
  sessionStorage.removeItem(STATE_KEY);

  const scope = params.get('scope');
  if (scope !== null && !scope.split(',').includes(REQUIRED_SCOPE)) {
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
    const state = await exchangeCode(creds as Creds, code);
    await saveTokens(state);
    return { kind: 'connected', athleteId: state.athleteId };
  } catch {
    return {
      kind: 'error',
      message:
        'Strava rejected that code. Authorization codes are single-use and expire quickly, so ' +
        'the usual fix is to authorize again and paste the fresh address.',
    };
  }
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

let inFlight: Promise<CallbackResult> | null = null;

/**
 * Completes the flow if this page load is a redirect back from Strava.
 *
 * Returns `none` for an ordinary visit, which is the common case -- callers should treat it as
 * "nothing happened", not as a failure.
 *
 * Memoised at module scope because StrictMode mounts every effect twice in development. The
 * exchange itself was always safe: the state is consumed and the URL cleaned synchronously
 * before the first await, so a second call finds no code and returns `none`. The damage was to
 * the *result* -- the real answer, including every error message, belonged to the first
 * invocation, whose caller had already been told to discard it. A denied consent, a state
 * mismatch, a missing scope and a rejected secret all produced total silence in `npm run dev`.
 */
export function completeAuthorization(): Promise<CallbackResult> {
  return (inFlight ??= runCompleteAuthorization());
}

async function runCompleteAuthorization(): Promise<CallbackResult> {
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
