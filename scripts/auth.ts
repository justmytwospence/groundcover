/**
 * One-time Strava OAuth. See docs/data-pipeline.md section 2.
 *
 *   npm run auth
 *
 * Writes .strava-token.json at the repo root, mode 0600, gitignored. Token values are never
 * printed. GroundCover holds its own refresh token and never reads or writes any other
 * project's token store (section 1.2).
 */

import { spawn } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REQUIRED_SCOPE, authorizeUrl, exchangeCode } from '@um/strava';

const PORT = 8721;
/** Strava matches its Authorization Callback Domain on host only, so any port works. */
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env.local');
const TOKEN_PATH = resolve(ROOT, '.strava-token.json');

/** Minimal KEY=VALUE parser: dotenv is not worth a dependency for two variables. */
function readEnvFile(path: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`Missing ${path}. Create it with STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.`);
    process.exit(1);
  }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function openInBrowser(url: string): void {
  if (process.platform !== 'darwin') return;
  try {
    const child = spawn('open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Opening is a convenience; the URL is printed either way.
  }
}

const env = readEnvFile(ENV_PATH);
const clientId = env.STRAVA_CLIENT_ID;
const clientSecret = env.STRAVA_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(`${ENV_PATH} must define both STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.`);
  process.exit(1);
}

function respond(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/callback') {
    respond(res, 404, 'Not found');
    return;
  }

  const denial = url.searchParams.get('error');
  if (denial !== null) {
    respond(res, 400, `Authorization failed: ${denial}`);
    console.error(`\nAuthorization was denied by Strava (${denial}).`);
    console.error('Re-run `npm run auth` and click Authorize, leaving every box checked.');
    server.close(() => process.exit(1));
    return;
  }

  const code = url.searchParams.get('code');
  if (code === null) {
    respond(res, 400, 'Missing authorization code');
    console.error('\nStrava redirected without an authorization code. Re-run `npm run auth`.');
    server.close(() => process.exit(1));
    return;
  }

  const granted = (url.searchParams.get('scope') ?? '').split(',');
  if (!granted.includes(REQUIRED_SCOPE)) {
    console.warn(
      `\nWarning: Strava did not grant ${REQUIRED_SCOPE}. Private activities will be missing ` +
        'and privacy-zone GPS will be trimmed. Re-run `npm run auth` and leave every box checked.',
    );
  }

  void (async () => {
    try {
      const token = await exchangeCode({ clientId, clientSecret }, code);
      writeFileSync(TOKEN_PATH, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
      // writeFileSync honours `mode` only when it creates the file.
      chmodSync(TOKEN_PATH, 0o600);

      respond(res, 200, 'Authorized, you can close this tab');
      console.log(
        `\nWrote .strava-token.json${token.athleteId !== undefined ? ` for athlete ${token.athleteId}` : ''}.`,
      );
      console.log('Next: npm run sync');
      server.close(() => process.exit(0));
    } catch (err) {
      respond(res, 500, 'Token exchange failed, see the terminal');
      console.error(`\nToken exchange failed: ${err instanceof Error ? err.message : String(err)}`);
      server.close(() => process.exit(1));
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  const url = authorizeUrl(clientId, REDIRECT_URI);
  console.log('Open this URL to authorize GroundCover against your Strava account:\n');
  console.log(`  ${url}\n`);
  console.log(`Waiting for the callback on ${REDIRECT_URI} ...`);
  openInBrowser(url);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop whatever holds it and re-run.`);
  } else {
    console.error(`Local callback server failed: ${err.message}`);
  }
  process.exit(1);
});
