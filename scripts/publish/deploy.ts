/**
 * Deploys the staged tree to the publish project through Vercel's REST API.
 *
 *   npm run publish:deploy            # stage, then this
 *   VERCEL_TOKEN=... npm run publish:deploy
 *
 * Why not just `vercel deploy`? Because the CLI cannot authenticate with a project-scoped token.
 * It calls GET /v2/user on startup, which a `vcp_` token answers with 404 "User not found", and
 * every command dies at `Error: User not found.` before it gets anywhere near a deployment. The
 * CLI therefore requires a token that can act on the whole account.
 *
 * That matters because this token lives in a PUBLIC repository's secret store. A project-scoped
 * token can only redeploy the map that is already public; an account-scoped one could also reach
 * the BYO deployment. The REST API accepts the scoped token perfectly well, so the deployment is
 * built here instead and the broad token is never created.
 *
 * Files are uploaded by SHA first and the deployment then references them, rather than inlining
 * base64 into one request body -- the bundle alone is well over a megabyte, and an inlined tree
 * puts the whole deployment into a single request that fails as a unit.
 *
 * No token value is ever printed.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, '.local', 'publish');
const API = 'https://api.vercel.com';

interface StagedFile {
  /** Deployment-relative POSIX path. */
  file: string;
  sha: string;
  size: number;
  body: Buffer;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

function token(): string {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  const p = join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json');
  if (existsSync(p)) {
    const { token: t } = JSON.parse(readFileSync(p, 'utf8')) as { token?: string };
    if (t) return t;
  }
  throw new Error('VERCEL_TOKEN is not set and no Vercel CLI credentials were found.');
}

function ids(): { orgId: string; projectId: string } {
  if (process.env.VERCEL_ORG_ID && process.env.VERCEL_PROJECT_ID) {
    return { orgId: process.env.VERCEL_ORG_ID, projectId: process.env.VERCEL_PROJECT_ID };
  }
  // A local run can fall back to the link `vercel link` left behind. CI has no such file, which
  // is why the environment variables come first.
  const p = join(OUT, '.vercel', 'project.json');
  if (!existsSync(p)) {
    throw new Error('Set VERCEL_ORG_ID and VERCEL_PROJECT_ID, or link .local/publish first.');
  }
  return JSON.parse(readFileSync(p, 'utf8')) as { orgId: string; projectId: string };
}

/** Every staged file except the local Vercel link, which is machine state, not deployment input. */
function collect(dir: string, acc: StagedFile[] = []): StagedFile[] {
  for (const name of readdirSync(dir)) {
    if (name === '.vercel') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collect(full, acc);
      continue;
    }
    const body = readFileSync(full);
    acc.push({
      file: relative(OUT, full).split(sep).join('/'),
      sha: createHash('sha1').update(body).digest('hex'),
      size: body.byteLength,
      body,
    });
  }
  return acc;
}

async function main(): Promise<void> {
  loadEnvFile(join(ROOT, '.env.publish.local'));
  const auth = token();
  const { orgId, projectId } = ids();

  if (!existsSync(OUT)) throw new Error('.local/publish is missing -- run `npm run publish:stage`');
  const files = collect(OUT);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  console.log(`uploading ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);

  for (const f of files) {
    const res = await fetch(`${API}/v2/files?teamId=${orgId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth}`,
        'Content-Length': String(f.size),
        'x-vercel-digest': f.sha,
      },
      body: new Uint8Array(f.body),
    });
    // 200 is a fresh upload; Vercel also accepts a file it already holds by digest.
    if (!res.ok) throw new Error(`upload ${f.file} failed: HTTP ${res.status}`);
  }

  const res = await fetch(`${API}/v13/deployments?teamId=${orgId}&skipAutoDetectionConfirmation=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'groundcover-spencer',
      project: projectId,
      target: 'production',
      files: files.map((f) => ({ file: f.file, sha: f.sha, size: f.size })),
      // Static output plus api/ functions, exactly as the staged tree already is. Left to
      // auto-detection Vercel would look for a framework build and find none.
      projectSettings: {
        framework: null,
        buildCommand: null,
        installCommand: null,
        outputDirectory: null,
      },
    }),
  });
  const body = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok) throw new Error(`deployment failed: HTTP ${res.status} ${body.error?.message ?? ''}`);

  const id = body.id!;
  console.log(`deployment ${id} created`);

  // Poll to a terminal state. Returning as soon as the API accepts the files would report
  // success for a deployment that goes on to fail its build minutes later.
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await fetch(`${API}/v13/deployments/${id}?teamId=${orgId}`, {
      headers: { Authorization: `Bearer ${auth}` },
    });
    const j = (await s.json()) as { readyState?: string; url?: string };
    if (j.readyState === 'READY') {
      console.log(`READY  https://${j.url ?? body.url}`);
      return;
    }
    if (j.readyState === 'ERROR' || j.readyState === 'CANCELED') {
      throw new Error(`deployment ${j.readyState}`);
    }
  }
  throw new Error('timed out waiting for the deployment to become READY');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
