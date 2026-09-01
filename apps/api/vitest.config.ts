import { defineConfig } from 'vitest/config';

// The hermetic unit suite: no database, no server, no clock — and no live
// provider. One setup file installs the runtime-knowledge port: since Stage 6
// the vocabularies (categories, roles, activities, verbs, topics, quality
// nouns) are runtime DATA, and any module that compiles them needs the port
// present before it reads. The acceptance suite installs it in its own
// global-setup; this config covers `npm test`.
export default defineConfig({
  test: {
    setupFiles: ['./src/test/runtime-content-setup.ts'],
  },
});
