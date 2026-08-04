import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCAL_ARTIFACTS = join(ROOT, '.local', 'artifacts');

/**
 * Serves the owner's locally-built artifacts at /artifacts during `npm run dev` only.
 *
 * They deliberately do NOT live in app/public: Vite copies public/ verbatim into dist/, so
 * anything there rides a production build onto a CDN. One person's coverage at 8 m resolution
 * is their home address, so the bytes stay outside every directory the build looks at, and the
 * only way to reach them is this middleware, which `apply: 'serve'` keeps out of a build.
 */
function localArtifacts(): Plugin {
  return {
    name: 'um-local-artifacts',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/artifacts', (req, res, next) => {
        const name = (req.url ?? '').split('?')[0].replace(/^\/+/, '');
        // Defeat traversal: only a bare filename from this one directory is ever served.
        if (!name || name.includes('/') || name.includes('..')) return next();
        const file = join(LOCAL_ARTIFACTS, name);
        if (!existsSync(file)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        );
        res.setHeader('Content-Length', String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localArtifacts()],
  resolve: {
    alias: {
      '@um/ledger': fileURLToPath(new URL('../packages/ledger/src/index.ts', import.meta.url)),
      '@um/strava': fileURLToPath(new URL('../packages/strava/src/index.ts', import.meta.url)),
    },
  },
  worker: { format: 'es' },
});
