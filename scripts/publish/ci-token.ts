/**
 * Mints the Vercel token CI uses to deploy the publish project, and stores it as a GitHub
 * repository secret.
 *
 *   VERCEL_TOKEN=<a temporary token> npm run publish:ci-token
 *
 * The VERCEL_TOKEN is required and cannot be avoided: Vercel refuses to mint API tokens from the
 * CLI's own OAuth session ("Cannot create tokens for this app"), so the credential `vercel login`
 * leaves behind is not enough. Create a throwaway at https://vercel.com/account/tokens, run this,
 * then delete the throwaway -- the scoped token this mints is what CI keeps using.
 *
 * The token is created with `projectId` set, which scopes it to groundcover-spencer alone. That
 * matters: a default Vercel token can act on every project in the account, and this one lives in
 * a public repository's secret store. Scoped, the worst case for a leaked CI token is redeploying
 * the map that is already public -- not touching the BYO deployment, and not reading the private
 * blob store, whose own token is never given to CI at all.
 *
 * The token value is piped straight into `gh secret set`. It is never printed, never written to
 * disk, and never returned. Re-running mints a fresh token and overwrites the secret; the old one
 * keeps working until deleted at https://vercel.com/account/tokens.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLISH_DIR = join(ROOT, '.local', 'publish');
const REPO = 'justmytwospence/groundcover';
const TOKEN_NAME = 'groundcover-spencer-ci';

function vercelAuthToken(): string {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const candidates = [
    join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
    join(homedir(), '.local', 'share', 'com.vercel.cli', 'auth.json'),
    join(homedir(), '.vercel', 'auth.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const { token } = JSON.parse(readFileSync(p, 'utf8')) as { token?: string };
    if (token) return token;
  }
  throw new Error('No Vercel credentials found. Run `vercel login`, or set VERCEL_TOKEN.');
}

function setSecret(name: string, value: string): void {
  execFileSync('gh', ['secret', 'set', name, '--repo', REPO], {
    input: value,
    stdio: ['pipe', 'ignore', 'inherit'],
  });
  console.log(`  ${name} set`);
}

async function main(): Promise<void> {
  const { projectId, orgId } = JSON.parse(
    readFileSync(join(PUBLISH_DIR, '.vercel', 'project.json'), 'utf8'),
  ) as { projectId: string; orgId: string };

  const res = await fetch(`https://api.vercel.com/v3/user/tokens?teamId=${orgId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${vercelAuthToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: TOKEN_NAME, projectId }),
  });
  if (!res.ok) {
    throw new Error(`token creation failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    token: { name: string; projectId?: string };
    bearerToken: string;
  };

  console.log(`token "${json.token.name}" created`);
  console.log(`  scoped to project: ${json.token.projectId ?? 'NOT SCOPED -- revoke this token'}`);
  if (!json.token.projectId) {
    throw new Error('Vercel returned an unscoped token; refusing to store it as a CI secret.');
  }

  setSecret('VERCEL_TOKEN', json.bearerToken);
  setSecret('VERCEL_ORG_ID', orgId);
  setSecret('VERCEL_PROJECT_ID', projectId);

  console.log('');
  console.log(`Secrets are on ${REPO}. The private blob token is deliberately NOT among them.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
