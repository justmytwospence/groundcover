import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/__tests__/**/*.test.ts',
      'app/src/**/__tests__/**/*.test.ts',
      'scripts/**/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    // The app's browser-facing modules touch sessionStorage, window.location and history at
    // import time. They are a small minority of the suite, so the default stays 'node' and
    // only they pay for a DOM.
    environmentMatchGlobs: [['app/src/**', 'jsdom']],
  },
});
