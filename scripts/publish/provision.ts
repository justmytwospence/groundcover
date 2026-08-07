/**
 * Creates the two blob stores the publish deployment needs, with the right access levels.
 *
 *   npm run publish:provision        # uses the token `vercel login` already stored
 *   VERCEL_TOKEN=... npm run publish:provision
 *
 * This exists because `vercel blob store add` cannot do it. The CLI has no access flag and the
 * REST API defaults `access` to "public", so a store created from the command line is public --
 * silently, with no warning, even if you name it "private". Putting the raw GPS corpus or a live
 * Strava refresh token in such a store would protect one person's home address with nothing but
 * an unguessable URL. So the store is created here, explicitly, with access: 'private'.
 *
 * Getting a store's read-write token out of Vercel is only possible by connecting the store to a
 * project, which mints the token as an environment variable. Two stores would collide on the
 * default name, so each connection sets its own `envVarPrefix`.
 *
 * Idempotent by way of the project's environment: a store whose token is already set is left
 * alone. No token value is ever printed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLISH_DIR = join(ROOT, '.local', 'publish');

const PUBLIC_STORE = 'groundcover-public';
const PRIVATE_STORE = 'groundcover-private';
const REGION = 'iad1';

interface ProjectLink {
  projectId: string;
  orgId: string;
  projectName: string;
}

function projectLink(): ProjectLink {
  const p = join(PUBLISH_DIR, '.vercel', 'project.json');
  if (!existsSync(p)) {
    throw new Error(`${p} is missing -- run: vercel link --yes --project groundcover-spencer --cwd .local/publish`);
  }
  return JSON.parse(readFileSync(p, 'utf8')) as ProjectLink;
}

/**
 * VERCEL_TOKEN if set, otherwise the token the Vercel CLI already holds from `vercel login`.
 *
 * Reading the CLI's own credential store avoids asking anyone to mint a second long-lived token
 * for a one-off provisioning run. The value is returned, never logged, and never written
 * anywhere -- the only place it goes is an Authorization header.
 */
function requireToken(): string {
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

  throw new Error(
    'No Vercel credentials found. Run `vercel login`, or set VERCEL_TOKEN from https://vercel.com/account/tokens.',
  );
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  teamId: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(`https://api.vercel.com${path}`);
  url.searchParams.set('teamId', teamId);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    // The body can echo request context; keep it to the status and Vercel's own error slug.
    let slug = '';
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      slug = j.error?.code ? ` (${j.error.code}: ${j.error.message ?? ''})` : '';
    } catch {
      /* no body */
    }
    throw new Error(`${method} ${path} failed: HTTP ${res.status}${slug}`);
  }
  // The connections endpoint answers 200 with an empty body, so an unconditional res.json()
  // turns a success into "Unexpected end of JSON input".
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

interface StoreRec {
  id: string;
  name: string;
  type?: string;
  access?: string;
  projectsMetadata?: unknown[];
}

/**
 * These three are not in Vercel's published OpenAPI spec, which documents only create, get and
 * delete -- and whose documented create path returns 403 for this token. They are the endpoints
 * the Vercel CLI itself calls (dist/index.js, `connectResourceToProject`), so they are as stable
 * as the CLI is. If a CLI upgrade breaks provisioning, re-check them there first.
 *
 * `type: 'integration'` is what the CLI sends for a native blob store too; there is no separate
 * blob connection type.
 */
const LIST_STORES = '/v1/storage/stores';
const CREATE_BLOB_STORE = '/v1/storage/stores/blob';
const connectionsPath = (storeId: string) => `/v1/storage/stores/${storeId}/connections`;
const ENV_TARGETS = ['production', 'preview', 'development'];

function vercel(args: string[], opts: { input?: string } = {}): string {
  return execFileSync('vercel', [...args, '--cwd', PUBLISH_DIR], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(opts.input !== undefined ? { input: opts.input } : {}),
  });
}

function envExists(name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(vercel(['env', 'ls']));
}

async function main(): Promise<void> {
  const token = requireToken();
  const link = projectLink();
  console.log(`project ${link.projectName} (${link.projectId})`);

  const listStores = async (): Promise<StoreRec[]> => {
    const r = await api<{ stores?: StoreRec[] }>(token, 'GET', `${LIST_STORES}?limit=100`, link.orgId);
    return r.stores ?? [];
  };

  /**
   * Creating and connecting are two calls. `projectId` in the create body is accepted and then
   * silently ignored -- the store comes back with an empty projectsMetadata -- so connecting has
   * to be explicit, and connecting is also the only way Vercel will hand over a read-write token.
   */
  const ensureStore = async (name: string, access: 'public' | 'private'): Promise<StoreRec> => {
    const existing = (await listStores()).find((s) => s.name === name && s.type === 'blob');
    if (existing) {
      if (existing.access !== access) {
        throw new Error(
          `store "${name}" already exists with access="${existing.access}", expected "${access}". ` +
            'Access cannot be changed after creation; delete it and re-run.',
        );
      }
      console.log(`  ${name}: exists (${existing.id}, ${access})`);
      return existing;
    }
    const created = await api<{ store: StoreRec }>(token, 'POST', CREATE_BLOB_STORE, link.orgId, {
      name,
      region: REGION,
      access,
    });
    console.log(`  ${name}: created ${access} (${created.store.id})`);
    return created.store;
  };

  /**
   * `envVarPrefix` decides the name Vercel mints: "BLOB" gives BLOB_READ_WRITE_TOKEN,
   * "PRIVATE_BLOB" gives PRIVATE_BLOB_READ_WRITE_TOKEN. Setting it here is the only correct way
   * to give two stores distinct names.
   *
   * Do NOT instead let both take the default and rename one afterwards. The token is bound to
   * the environment variable Vercel created: deleting that variable REVOKES the token, so a
   * copied-then-renamed value authenticates against nothing and every call fails with "Access
   * denied" long after the mistake.
   */
  const connect = async (store: StoreRec, envVarPrefix: string): Promise<void> => {
    try {
      await api(token, 'POST', connectionsPath(store.id), link.orgId, {
        envVarEnvironments: ENV_TARGETS,
        projectId: link.projectId,
        type: 'integration',
        envVarPrefix,
      });
    } catch (err) {
      // Already connected is the desired state, not a failure. Without this, any re-run after a
      // partial provision dead-ends here and the only way forward is unpicking it by hand.
      const m = err instanceof Error ? err.message : '';
      if (m.includes('store_project_connection_not_unique')) {
        console.log(`  ${store.name}: already connected`);
        return;
      }
      throw err;
    }
  };

  for (const [store, access, prefix, envVar] of [
    [PRIVATE_STORE, 'private', 'PRIVATE_BLOB', 'PRIVATE_BLOB_READ_WRITE_TOKEN'],
    [PUBLIC_STORE, 'public', 'BLOB', 'BLOB_READ_WRITE_TOKEN'],
  ] as const) {
    if (envExists(envVar)) {
      console.log(`  ${envVar} already set`);
      continue;
    }
    await connect(await ensureStore(store, access), prefix);
    console.log(`  ${envVar} set`);
  }

  // A store whose access level is wrong is not recoverable in place, so say plainly what is
  // there rather than letting a later seed discover it the hard way.
  for (const s of await listStores()) {
    if (s.type === 'blob') console.log(`  store ${s.name}: access=${s.access}`);
  }

  console.log('');
  console.log('Stores provisioned. Next:');
  console.log('  vercel env add STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET / CRON_SECRET');
  console.log('  vercel env pull .env.publish.local --cwd .local/publish');
  console.log('  npm run publish:seed');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
