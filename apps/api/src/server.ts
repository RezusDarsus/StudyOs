import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { SESSION_COOKIE, resolveSession } from './lib/auth.js';
import { auditConfig, reportConfig, trustProxySetting } from './lib/config-audit.js';
import { HttpError, unauthorized } from './lib/errors.js';
import { prisma } from './lib/prisma.js';
import { startJobs, stopJobs } from './jobs/boss.js';
import authRoutes from './routes/auth.js';
import goalRoutes from './routes/goals.js';
import healthRoutes from './routes/health.js';
import taskRoutes from './routes/tasks.js';
import progressionRoutes from './routes/progression.js';
import socialRoutes from './routes/social.js';
import miscRoutes from './routes/misc.js';
import realtimeRoutes from './routes/realtime.js';
import copilotRoutes from './routes/copilot.js';
import recommendationRoutes from './routes/recommendations.js';
import { registerCapabilities } from './capabilities/index.js';
import { installRuntimeContent } from './runtime-content.js';

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthedUser | null;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export async function buildServer() {
  // Stage 3: the runtime-knowledge port is composed and installed explicitly,
  // before any consumer can read it. Unconditional — the runtime-content flag
  // gates consumption, not composition; with the flag off nothing reads it.
  installRuntimeContent();
  // Stage 4: capability definitions register once at boot. Duplicate names
  // would throw here — before the first request, not after it.
  registerCapabilities();
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // Off unless TRUST_PROXY says otherwise — see lib/config-audit.ts. In this deployment
    // nginx is the only thing that talks to the API, so `TRUST_PROXY=true` there makes
    // req.ip the real client rather than the proxy's container address.
    //
    // `null` means the value was set to something unusable. The audit below refuses to boot
    // over it, but this line runs first, so it has to choose something in the meantime: not
    // trusting the header is the safe half of the mistake.
    trustProxy: trustProxySetting() ?? false,
    // Explicit, and smaller than Fastify's 1MB default. Nothing this API accepts is large:
    // the biggest legitimate body is a Copilot draft, a few kilobytes of JSON. A limit is
    // the cheapest defence there is against a body that exists only to occupy memory.
    bodyLimit: 256 * 1024,
  });

  // Origins to accept credentialed cross-origin requests from.
  //
  // A list, never a wildcard: `*` with credentials is refused by every browser anyway, and
  // reflecting the request's own Origin — the usual workaround — hands any site on the
  // internet an authenticated session with this API. The audit above refuses to start on a
  // wildcard here, so this stays a fixed allowlist.
  //
  // In the containerised deployment nothing reaches this: nginx serves the app and the API
  // on one origin, so the browser makes no cross-origin request at all. It matters for the
  // Vite dev server on another port, and for anyone pointing a separate front end here.
  const corsOrigins = (process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:5173'])
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: corsOrigins,
    credentials: true,
  });
  await app.register(cookie);

  // Several endpoints take no body. Fastify's default JSON parser rejects an
  // empty body outright when the client still sends application/json, which is
  // what most HTTP clients do by default — so treat empty as {}.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (!text || text.trim() === '') return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        const err = Object.assign(new Error('Invalid JSON body'), { statusCode: 400 });
        done(err);
      }
    },
  );

  // Resolve the session on every request; routes opt in to requiring it.
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    const session = await resolveSession(req.cookies[SESSION_COOKIE]);
    req.user = session ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
  });

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    if (!req.user) throw unauthorized();
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'Please check the highlighted fields',
        code: 'VALIDATION',
        fields: error.flatten().fieldErrors,
      });
    }
    const fastifyError = error as { statusCode?: number; message?: string };
    if (fastifyError.statusCode === 400) {
      return reply
        .status(400)
        .send({ error: fastifyError.message ?? 'Bad request', code: 'BAD_REQUEST' });
    }
    req.log.error(error);
    return reply.status(500).send({ error: 'Something went wrong', code: 'INTERNAL' });
  });

  // No prefix, unlike everything below: these are for the orchestrator, not the browser.
  await app.register(healthRoutes);

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(goalRoutes, { prefix: '/api' });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.register(progressionRoutes, { prefix: '/api' });
  await app.register(socialRoutes, { prefix: '/api' });
  await app.register(miscRoutes, { prefix: '/api' });
  await app.register(realtimeRoutes, { prefix: '/api' });
  await app.register(copilotRoutes, { prefix: '/api' });
  await app.register(recommendationRoutes, { prefix: '/api' });

  return app;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  const app = await buildServer();

  // Before the port opens. Every setting whose failure mode is silent gets checked here,
  // and anything that would make this deployment exploitable from outside stops the boot:
  // a container that never becomes healthy is a problem someone fixes today.
  try {
    reportConfig(auditConfig(), {
      warn: (message) => app.log.warn(message),
      error: (message) => app.log.error(message),
    });
  } catch (err) {
    app.log.error((err as Error).message);
    process.exit(1);
  }

  const port = Number(process.env.PORT ?? 4000);
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Started here and not in buildServer() on purpose: buildServer is what tests and
  // tooling call to get routes, and it must not open a second connection pool or start
  // firing scheduled notifications as a side effect of being constructed.
  await startJobs(app.log).catch((err) =>
    app.log.error({ err }, 'jobs: failed to start — scheduled notifications are not running'),
  );

  const shutdown = async () => {
    // Jobs first: let the tick in flight finish and release its rows, so a redeploy
    // resumes rather than leaving a job stuck in `active` until it expires.
    await stopJobs();
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
