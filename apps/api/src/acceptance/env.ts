// Redirect this worker at the acceptance database, before anything can connect to the
// development one.
//
// Ordering is the entire content of this file. `src/lib/prisma.ts` runs `new PrismaClient()`
// at module load and passes no explicit datasource, so the client is bound to whatever
// DATABASE_URL says at that moment. Vitest runs setup files before it imports any test
// module, which makes this the last point where that value can still be changed.
//
// The bare `@prisma/client` import is a side effect, not a dependency: importing it is what
// loads apps/api/.env into process.env. Doing that first, on purpose, means the overrides
// below cannot be undone by a later import — the alternative is relying on dotenv's
// "existing keys win" rule, which is true but is not something a test suite that truncates
// tables should be resting on.

import '@prisma/client';
import { acceptanceDatabaseUrl } from './database.js';

process.env.DATABASE_URL = acceptanceDatabaseUrl();

process.env.NODE_ENV = 'test';
// Fastify's logger is otherwise chatty enough to bury the test output.
process.env.LOG_LEVEL = 'silent';
// The suite drives the tick by hand, with a clock it chooses. A background poller firing
// the same handler against the same rows would make every notification assertion a race.
process.env.JOBS_ENABLED = 'false';
process.env.WEB_ORIGIN = 'http://localhost:5173';
// req.ip must be the injected peer, not a header — the auth throttles are keyed on it.
process.env.TRUST_PROXY = '';

// Emptied rather than deleted, and both for the same reason: an absent key is a key the
// next `.env` load is free to fill in, while an empty one reads as "configured off"
// everywhere it is checked (realtimeConfig trims and rejects it, createProvider sees no
// credentials). No acceptance test may reach the real provider or the developer's
// Centrifugo; the two that care about realtime configure it themselves.
process.env.NVIDIA_API_KEY = '';
process.env.CENTRIFUGO_URL = '';
process.env.CENTRIFUGO_API_KEY = '';
process.env.CENTRIFUGO_TOKEN_HMAC_SECRET = '';
process.env.CENTRIFUGO_WS_URL = '';
