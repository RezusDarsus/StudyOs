import { defineConfig } from 'vitest/config';

// The acceptance suite, run on its own: `npm run test:acceptance --workspace @goalify/api`.
//
// Separate from `npm test` deliberately, and the split is not about speed. The 300-odd
// unit tests are hermetic — no database, no server, no clock — and that is what makes them
// worth running on every save. These twelve drive the real Fastify instance against a real
// PostgreSQL, truncate every table between tests, and one of them waits on pg-boss's
// polling interval. Mixing the two would make the fast suite as slow and as fragile as the
// slow one, and would mean a developer without Docker running could no longer run any tests.
//
// The file suffix is what keeps them apart: `*.acceptance.ts` matches nothing in Vitest's
// default `include`, so `npm test` cannot pick these up even by accident.
export default defineConfig({
  test: {
    include: ['src/acceptance/**/*.acceptance.ts'],
    // Creates the acceptance database and applies migrations, once for the whole run.
    globalSetup: ['src/acceptance/global-setup.ts'],
    // Runs in each worker before any test module is imported, which is the only point at
    // which DATABASE_URL can still be redirected — see env.ts.
    setupFiles: ['src/acceptance/env.ts'],
    // One database, truncated between tests. Two files in parallel would delete each
    // other's fixtures halfway through.
    fileParallelism: false,
    // The durability test restarts pg-boss and waits for its poller, which is on a
    // 15-second interval.
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
