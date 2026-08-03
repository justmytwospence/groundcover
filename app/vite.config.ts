import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@um/ledger': fileURLToPath(new URL('../packages/ledger/src/index.ts', import.meta.url)),
    },
  },
  worker: { format: 'es' },
});
