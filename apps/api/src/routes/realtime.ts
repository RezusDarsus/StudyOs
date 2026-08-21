// The realtime handshake.
//
// One endpoint, and the only thing it decides is who the socket belongs to. That decision
// comes from the session cookie via req.user and from nothing else: there is no userId in
// the path, the query or the body, because a userId that arrives from the client is a
// userId the client can change. Centrifugo then enforces the same identity again at
// subscribe time against the `sub` in the token we sign here.

import type { FastifyInstance } from 'fastify';
import {
  CONNECTION_TOKEN_TTL_SECONDS,
  channelFor,
  issueConnectionToken,
  realtimeConfig,
} from '../services/realtime.js';

export default async function realtimeRoutes(app: FastifyInstance) {
  /**
   * Everything the browser needs to open its socket, or an honest "not available".
   *
   * Returning 200 with `enabled: false` rather than an error: a deployment without
   * Centrifugo is a supported configuration, not a fault, and the widget's job in that
   * case is to fall back to fetching rather than to show the user a failure.
   *
   * The client calls this again when its token expires, which is why the TTL is returned
   * alongside — Centrifugo's SDK refreshes through the same route.
   */
  app.get('/realtime/token', { preHandler: app.requireAuth }, async (req) => {
    const config = realtimeConfig();
    if (!config) return { enabled: false as const };

    const userId = req.user!.id;
    return {
      enabled: true as const,
      url: config.websocketUrl,
      token: issueConnectionToken(userId, config.hmacSecret),
      // Sent rather than derived on the client so that the channel naming rule lives in
      // one place. The client could construct it — but then two implementations would
      // have to agree, and Centrifugo would silently deny the subscription if they did not.
      channel: channelFor(userId),
      expiresInSeconds: CONNECTION_TOKEN_TTL_SECONDS,
    };
  });
}
