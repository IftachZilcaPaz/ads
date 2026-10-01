import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // In-process Postgres (PGlite) can take a while to boot on a busy machine.
    hookTimeout: 30_000,
  },
});
