/**
 * Strava OAuth. See docs/data-pipeline.md section 2.
 *
 * Nothing in this module logs, prints, or embeds a token value in an error message. Error
 * messages carry the HTTP status only.
 */

import { z } from 'zod';

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';

/**
 * activity:read_all, not activity:read. Without it, "Only You" activities are silently
 * missing and privacy-zone GPS is trimmed, so a coverage map would quietly be wrong.
 */
export const REQUIRED_SCOPE = 'activity:read_all';

export interface Creds {
  clientId: string;
  clientSecret: string;
}

export interface TokenState {
  refreshToken: string;
  accessToken?: string;
  /** Unix seconds. Access tokens live 6 hours. */
  expiresAt?: number;
  athleteId?: number;
}

export interface MintedToken {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  /** True when Strava handed back a different refresh token, which the caller must persist. */
  rotated: boolean;
}

const TokenResponseSchema = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    expires_at: z.number(),
    athlete: z.object({ id: z.number() }).passthrough().nullable().optional(),
  })
  .passthrough();

async function postToken(body: URLSearchParams): Promise<z.infer<typeof TokenResponseSchema>> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    // Deliberately no response body: the request carried a secret and the reply may echo it.
    throw new Error(`Strava token request failed: HTTP ${res.status}`);
  }
  return TokenResponseSchema.parse(await res.json());
}

/**
 * Exchanges the stored refresh token for a fresh access token. Strava rotates the refresh
 * token on every refresh, so the caller must persist `refreshToken` immediately when
 * `rotated` is true, before doing anything else that could throw.
 */
export async function mintAccessToken(creds: Creds, state: TokenState): Promise<MintedToken> {
  const json = await postToken(
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: state.refreshToken,
    }),
  );
  return {
    accessToken: json.access_token,
    expiresAt: json.expires_at,
    refreshToken: json.refresh_token,
    rotated: json.refresh_token !== state.refreshToken,
  };
}

/** The one-time authorization-code exchange run by scripts/auth.ts. */
export async function exchangeCode(
  creds: Creds,
  code: string,
): Promise<TokenState & { accessToken: string; expiresAt: number }> {
  const json = await postToken(
    new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'authorization_code',
      code,
    }),
  );
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: json.expires_at,
    athleteId: json.athlete?.id,
  };
}

export function authorizeUrl(clientId: string, redirectUri: string): string {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'force',
    scope: REQUIRED_SCOPE,
  });
  return `${AUTHORIZE_URL}?${query.toString()}`;
}
