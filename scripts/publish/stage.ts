/**
 * Stages the publish deployment into .local/publish/.
 *
 *   npm run publish:stage
 *
 * The publish deployment is a SEPARATE Vercel project deployed from a staged directory, not a
 * second build of this repo. Two reasons, both structural:
 *
 *   - One repo can hold one vercel.json, and the two deployments need different ones: this one
 *     declares a cron and a function, and its CSP allows the blob origin while forbidding
 *     Strava, which is the exact inverse of the BYO deployment's.
 *   - Deploying a directory that contains only the built bundle means `data/`, `.local/
 *     artifacts/`, `.env.local` and `.strava-token.json` are not merely ignored during upload,
 *     they are not in the tree being uploaded at all. The BYO deployment's guarantee in
 *     SPEC.md section 0 is untouched by anything that happens here.
 *
 * The function is bundled to a single file, so the staged tree has no dependencies to install
 * and no workspace to resolve.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, '.local', 'publish');
const APP_DIST = join(ROOT, 'app', 'dist');

/** 09:00 UTC. Hobby cron is once-daily with up to 59 minutes of slop, which is fine for a map. */
const CRON_SCHEDULE = '0 9 * * *';

/**
 * Packages the function imports at runtime rather than having bundled. Versions are read from
 * this repo's own lockfile resolution at stage time, so the deployment installs exactly what was
 * tested here rather than whatever the range floats to later.
 */
const FUNCTION_DEPS = new Map([['@vercel/blob', '']]);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (put it in .env.publish.local)`);
  return v;
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    total += s.isDirectory() ? dirSize(p) : s.size;
  }
  return total;
}

async function main(): Promise<void> {
  loadEnvFile(join(ROOT, '.env.publish.local'));

  const pointer = requireEnv('PUBLISH_POINTER_URL');
  const byoUrl = process.env.PUBLISH_BYO_URL ?? '';

  // Clear the staged tree but keep .vercel/: it holds the link to the publish project, and
  // blowing it away would silently turn the next `vercel deploy` into a prompt for a NEW
  // project -- or, worse, into a deploy against whichever project it guessed.
  if (existsSync(OUT)) {
    for (const name of readdirSync(OUT)) {
      if (name === '.vercel') continue;
      rmSync(join(OUT, name), { recursive: true, force: true });
    }
  }
  mkdirSync(join(OUT, 'api'), { recursive: true });

  // ---- the app ---------------------------------------------------------------------------
  // VITE_PUBLISH_POINTER is what flips artifactSource.ts into the published source and, by
  // being undefined in every other build, is what keeps that code out of the BYO bundle.
  console.log('building the app in publish mode ...');
  execFileSync('npm', ['-w', 'app', 'run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_PUBLISH_POINTER: pointer,
      VITE_PUBLISH_BYO_URL: byoUrl,
    },
  });
  cpSync(APP_DIST, OUT, { recursive: true });

  // ---- the cron function -----------------------------------------------------------------
  console.log('bundling the refresh function ...');
  await build({
    entryPoints: [join(ROOT, 'scripts', 'publish', 'handler.ts')],
    outfile: join(OUT, 'api', 'refresh.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    // Everything is bundled -- including the workspace packages, which exist only as TypeScript
    // source -- EXCEPT @vercel/blob. Its transitive dependency `jose` is CommonJS and does a
    // dynamic require('node:buffer'), which esbuild cannot shim into an ESM bundle: the output
    // imports fine locally right up until it is invoked, then fails at module load with
    // "Dynamic require of node:buffer is not supported" and a bare FUNCTION_INVOCATION_FAILED.
    // Left external and declared as a dependency below, Vercel installs it and Node resolves it
    // natively.
    external: [...FUNCTION_DEPS.keys()],
    logLevel: 'warning',
  });

  // ---- deployment config ------------------------------------------------------------------
  const dependencies: Record<string, string> = {};
  for (const name of FUNCTION_DEPS.keys()) {
    const { version } = JSON.parse(
      readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version: string };
    dependencies[name] = version;
  }

  writeFileSync(
    join(OUT, 'package.json'),
    `${JSON.stringify(
      { name: 'groundcover-publish', private: true, type: 'module', dependencies },
      null,
      2,
    )}\n`,
  );

  const csp = [
    "default-src 'self'",
    "script-src 'self' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Strava is deliberately absent: this deployment holds no credentials and makes no API
    // call from the browser. The blob origin serves the artifacts. Both basemap hosts are
    // listed because the map falls through to the second when the first is down -- keep this
    // in step with BASEMAP_STYLES in app/src/lib/theme.ts.
    "connect-src 'self' https://*.public.blob.vercel-storage.com https://tiles.openfreemap.org https://*.cartocdn.com https://s3.amazonaws.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');

  writeFileSync(
    join(OUT, 'vercel.json'),
    `${JSON.stringify(
      {
        $schema: 'https://openapi.vercel.sh/vercel.json',
        crons: [{ path: '/api/refresh', schedule: CRON_SCHEDULE }],
        functions: { 'api/refresh.js': { maxDuration: 300 } },
        // Rewrites are evaluated after the filesystem check, so /api/refresh resolves to the
        // function and never reaches this catch-all. Same rule as the BYO deployment.
        rewrites: [{ source: '/(.*)', destination: '/index.html' }],
        headers: [
          {
            source: '/assets/(.*)',
            headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
          },
          {
            source: '/(.*)',
            headers: [
              { key: 'Content-Security-Policy', value: csp },
              { key: 'X-Content-Type-Options', value: 'nosniff' },
              { key: 'Referrer-Policy', value: 'no-referrer' },
              { key: 'Permissions-Policy', value: 'geolocation=(), camera=(), microphone=()' },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  console.log('');
  console.log(`staged ${OUT}  (${(dirSize(OUT) / 1e6).toFixed(1)} MB)`);
  console.log(`  pointer   ${pointer}`);
  console.log(`  cron      ${CRON_SCHEDULE}  (once daily)`);
  console.log(byoUrl ? `  byo link  ${byoUrl}` : '  byo link  (unset; the footer link is omitted)');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
