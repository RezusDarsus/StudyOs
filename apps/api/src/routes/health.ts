// The two endpoints an orchestrator reads.
//
// Registered without the /api prefix, and that is not an oversight: nginx proxies /api and
// the WebSocket path and nothing else, so from the browser's side of the deployment these
// two do not exist — a request for /health falls through to the single-page application.
// They are reachable from inside the container network, which is where Docker's healthcheck
// and any future orchestrator's probes run from. An unauthenticated endpoint that reports
// which dependencies are down should be readable by exactly that audience.
//
// If an outside uptime monitor ever needs them, the right change is a location block in
// apps/web/nginx.conf, made deliberately, rather than moving these under /api where every
// browser on the internet can read them.

import type { FastifyInstance } from 'fastify';
import { liveness, readiness } from '../services/health.js';

export default async function healthRoutes(app: FastifyInstance) {
  // `logLevel: 'warn'` on both routes, because the container healthcheck calls one of them
  // every ten seconds: at the default level that is eight thousand request/response pairs a
  // day, which is not information, and which buries the lines that are. A failed dependency
  // check logs at warn from inside the handler and still comes through.

  /** Liveness. 200 while this process can run a handler at all. */
  app.get('/health', { logLevel: 'warn' }, async () => liveness());

  /**
   * Readiness. 503 when the database is unreachable, 200 otherwise — including when
   * realtime or the scheduler is down, which is reported in the body as `degraded` but is
   * not a reason to stop serving requests.
   *
   * The status code rather than only the body carries the verdict, because the things that
   * read this route — Docker's healthcheck, a load balancer, `compose up --wait` — route on
   * the code and would treat a 200 with `"ok": false` as healthy.
   */
  app.get('/health/ready', { logLevel: 'warn' }, async (req, reply) => {
    const result = await readiness({
      onError: (check, err) => req.log.warn({ err, check }, 'health: dependency check failed'),
    });
    return reply.status(result.ok ? 200 : 503).send(result);
  });
}
