/**
 * The visitor's own Strava app credentials and rotating tokens.
 *
 * Every value here belongs to the person using the browser it is stored in. They register their
 * own Strava application, so the client secret is their secret, guarding their own data, held in
 * their own browser -- there is no server that could hold it instead. Strava's OAuth has no PKCE
 * flow, so a confidential-client secret is the only exchange they offer; this is the honest
 * shape of that constraint rather than a shortcut around it.
 *
 * Nothing in this module logs, prints, or embeds a credential in an error message.
 */

import { mintAccessToken, type Creds, type TokenState } from '@um/strava';
import { get, put, STORE_CREDS } from '../lib/db.js';

const KEY_APP = 'app';
const KEY_TOKEN = 'token';

/** Refresh this many seconds before the access token actually expires. */
const EXPIRY_MARGIN_S = 300;

interface Row<T> {
  k: string;
  v: T;
}

export async function saveCreds(creds: Creds): Promise<void> {
  await put(STORE_CREDS, { k: KEY_APP, v: creds } satisfies Row<Creds>);
}

export async function loadCreds(): Promise<Creds | null> {
  const row = await get<Row<Creds>>(STORE_CREDS, KEY_APP);
  const v = row?.v;
  if (!v || !v.clientId || !v.clientSecret) return null;
  return v;
}

export async function saveTokens(state: TokenState): Promise<void> {
  await put(STORE_CREDS, { k: KEY_TOKEN, v: state } satisfies Row<TokenState>);
}

export async function loadTokens(): Promise<TokenState | null> {
  const row = await get<Row<TokenState>>(STORE_CREDS, KEY_TOKEN);
  return row?.v?.refreshToken ? row.v : null;
}

export async function isConnected(): Promise<boolean> {
  return (await loadCreds()) !== null && (await loadTokens()) !== null;
}

export class NotConnectedError extends Error {
  constructor() {
    super('Not connected to Strava.');
    this.name = 'NotConnectedError';
  }
}

/**
 * A usable access token, refreshing when the cached one is close to expiry.
 *
 * Strava rotates the refresh token on every refresh and invalidates the previous one
 * immediately. If we used the new access token and only persisted afterwards, any throw in
 * between would strand the user holding a refresh token Strava no longer honours, with no way
 * back except redoing the whole authorization. So the write happens first, before this function
 * returns anything a caller could act on.
 */
export async function accessToken(): Promise<string> {
  const creds = await loadCreds();
  const stored = await loadTokens();
  if (!creds || !stored) throw new NotConnectedError();

  const now = Math.floor(Date.now() / 1000);
  if (stored.accessToken && stored.expiresAt && stored.expiresAt - EXPIRY_MARGIN_S > now) {
    return stored.accessToken;
  }

  const minted = await mintAccessToken(creds, stored);
  try {
    await saveTokens({
      refreshToken: minted.refreshToken,
      accessToken: minted.accessToken,
      expiresAt: minted.expiresAt,
      athleteId: stored.athleteId,
    });
  } catch (err) {
    // The write failed -- storage full, most likely -- but Strava has already invalidated the
    // refresh token we came in with. The one in memory is now the only valid credential in
    // existence and it is about to be lost, so say so in terms that name the remedy. Silently
    // returning the access token would work for six hours and then strand the user for good.
    throw new Error(
      'Your Strava sign-in was renewed but could not be saved, most likely because this ' +
        'browser is out of storage. Free up space and sign in again. Your downloaded ' +
        'activities are untouched.',
      { cause: err },
    );
  }
  return minted.accessToken;
}

/**
 * Force the next `accessToken()` call to mint a fresh one.
 *
 * Strava can reject a token that has not yet reached its stated expiry -- the user revoked the
 * app, or it was invalidated server-side. Only a 401 reveals that, so the caller that sees one
 * needs a way to say "the cached value is a lie" without knowing anything about storage layout.
 */
export async function invalidateAccessToken(): Promise<void> {
  const stored = await loadTokens();
  if (!stored) return;
  await saveTokens({ refreshToken: stored.refreshToken, athleteId: stored.athleteId });
}
