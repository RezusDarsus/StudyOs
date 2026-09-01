// What the server checks about its own configuration before it agrees to serve traffic.
// Every setting here has a failure mode that is quiet. A wildcard CORS origin, a
// Centrifugo secret still set to the value published in .env.example, an https-only cookie
// on an http deployment: none of these throw, none of them show up in a smoke test, and
// each one is either a security hole or an outage that presents as "the app is just
// broken". Somewhere between reading the environment and accepting the first request is
// the only good moment to notice.
//
// Two severities, and the line between them is deliberate:
//
//   fatal    the deployment is exploitable from outside, right now. Refuse to start. A
//            process that will not boot gets fixed in minutes; one that boots insecurely
//            gets fixed after someone notices, which may be never.
//   warning  something is broken, misconfigured or degraded, but not an open door. Say so
//            loudly and carry on — refusing to start over a missing AI key would turn a
//            partial outage into a total one.
//
// Nothing in this module ever includes a configured value in its output. The findings name
// settings and describe what is wrong with them, because this text goes to a log that gets
// pasted into issues and chat windows, and a message that quotes DATABASE_URL to prove it
// is malformed has published the database password to all of them.

/** Values that appear in .env.example, and are therefore not secrets. */
const PLACEHOLDERS = new Set(['replace-me', 'change-me', 'changeme', 'secret', 'password', 'test']);

export type Severity = 'fatal' | 'warning';

export interface Finding {
  severity: Severity;
  /** The environment variable at fault, for the reader to go and look at. */
  setting: string;
  message: string;
}

const isPlaceholder = (value: string | undefined): boolean =>
  value !== undefined && PLACEHOLDERS.has(value.trim().toLowerCase());

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';

/**
 * Parse one CORS origin, or explain what is wrong with it.
 *
 * An origin is a scheme, a host and a port â€” nothing else. `https://app.example.com/`
 * with its trailing slash and `app.example.com` without a scheme are both things people
 * write, and @fastify/cors compares the browser's Origin header against them literally,
 * so both silently match nothing. An allowlist that matches nothing looks exactly like an
 * allowlist that works until the day a browser actually sends a cross-origin request.
 */
function originProblem(entry: string): string | null {
  if (entry === '*') {
    return 'is a wildcard, which cannot be combined with credentialed requests: browsers refuse to send cookies to `*`, so every authenticated cross-origin call would fail, and any origin that did not need credentials would be granted access to the API';
  }
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return 'is not an absolute origin â€” it needs a scheme, as in https://app.example.com';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'has a scheme that is not http or https';
  }
  // One comparison that catches every non-matching form at once: an entry is only usable
  // if it is identical to its own parsed origin. A trailing slash, a path, an uppercase
  // host, an explicit :443 â€” the URL parser normalises all of them away, and the browser
  // sends the normalised form, so any entry that differs from it can never match.
  if (entry !== url.origin) {
    return `is not in the form a browser sends. An Origin header is scheme://host[:port] â€” no trailing slash or path, lowercase host, and the default port omitted â€” and it is compared literally, so this entry would match nothing (it would have to be written ${url.origin})`;
  }
  return null;
}

/**
 * Read the environment and report everything wrong with it.
 *
 * Pure: it takes the environment, returns findings, and neither logs nor throws. The
 * decision about what to do with a fatal finding belongs to the caller, which is what
 * lets the tests assert on every rule without a process to restart.
 */
export function auditConfig(
  env: NodeJS.ProcessEnv = process.env,
): Finding[] {
  const findings: Finding[] = [];
  const production = env.NODE_ENV === 'production';
  const fatal = (setting: string, message: string) =>
    findings.push({ severity: production ? 'fatal' : 'warning', setting, message });
  const warn = (setting: string, message: string) =>
    findings.push({ severity: 'warning', setting, message });

  // --- the database -----------------------------------------------------------
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    fatal('DATABASE_URL', 'is not set; the API cannot serve a single authenticated request without it');
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      fatal('DATABASE_URL', 'is not a valid URL');
    }
    if (parsed && production) {
      const password = decodeURIComponent(parsed.password);
      if (!password) {
        warn('DATABASE_URL', 'has no password');
      } else if (isPlaceholder(password)) {
        // A warning rather than fatal: the database is reachable from the container
        // network and loopback, not from the internet, so this is a weakness rather than
        // an open door â€” and stopping a local production-profile run over it would train
        // everyone to skip the check.
        warn(
          'DATABASE_URL',
          'still uses the placeholder password from .env.example, which is published in this repository',
        );
      }
    }
  }

  // --- CORS -------------------------------------------------------------------
  const webOrigin = env.WEB_ORIGIN?.trim();
  if (!webOrigin) {
    // Not fatal: with no value the server falls back to the dev origin, which fails
    // closed. A same-origin deployment behind a reverse proxy never makes a cross-origin
    // request at all and is entitled to leave this unset.
    if (production) {
      warn(
        'WEB_ORIGIN',
        'is not set, so cross-origin browser requests fall back to the development origin and will be refused. Harmless behind a same-origin proxy; set it explicitly otherwise',
      );
    }
  } else {
    for (const entry of webOrigin.split(',').map((value) => value.trim())) {
      if (!entry) continue;
      const problem = originProblem(entry);
      if (problem) fatal('WEB_ORIGIN', `contains an entry that ${problem}`);
      else if (production && entry.startsWith('http://')) {
        const { hostname } = new URL(entry);
        if (!isLoopback(hostname)) {
          // The specific, confusing consequence: NODE_ENV=production sets `secure` on the
          // session cookie, so the browser will not store or send it over plain http.
          // Logging in appears to succeed and every subsequent request is anonymous.
          warn(
            'WEB_ORIGIN',
            'names a plain-http origin that is not loopback. In production the session cookie is set Secure, so no browser will send it over http: users will appear to log in and then be anonymous on the next request',
          );
        }
      }
    }
  }

  // --- realtime ---------------------------------------------------------------
  // Fatal for a placeholder here, unlike the database password, because this secret is
  // remotely exploitable by design: it is the only thing that decides whose notification
  // stream a socket may read. Anyone holding it can sign a connection token for any user.
  const centrifugoParts = {
    CENTRIFUGO_URL: env.CENTRIFUGO_URL?.trim(),
    CENTRIFUGO_API_KEY: env.CENTRIFUGO_API_KEY?.trim(),
    CENTRIFUGO_TOKEN_HMAC_SECRET: env.CENTRIFUGO_TOKEN_HMAC_SECRET?.trim(),
  };
  for (const setting of ['CENTRIFUGO_API_KEY', 'CENTRIFUGO_TOKEN_HMAC_SECRET'] as const) {
    if (isPlaceholder(centrifugoParts[setting])) {
      fatal(
        setting,
        'is the placeholder from .env.example. It is published in this repository, and holding it is enough to read any user\'s realtime stream',
      );
    }
  }
  const configured = Object.values(centrifugoParts).filter(Boolean).length;
  if (configured > 0 && configured < 3) {
    // Half-configured is worse than absent: the API would sign tokens no Centrifugo
    // verifies, or publish with a key it will not accept. Both look like working software.
    warn(
      'CENTRIFUGO_URL',
      'realtime is partly configured â€” CENTRIFUGO_URL, CENTRIFUGO_API_KEY and CENTRIFUGO_TOKEN_HMAC_SECRET are needed together, and realtime stays switched off until all three are set',
    );
  }

  // --- the AI provider --------------------------------------------------------
  // A warning in every environment. The Copilot is one feature; goals, tasks, streaks and
  // the leaderboard do not touch it, and refusing to boot would take all of them down too.
  if ((env.AI_PROVIDER ?? 'nvidia') === 'nvidia' && !env.NVIDIA_API_KEY?.trim()) {
    warn('NVIDIA_API_KEY', 'is not set; the goal Copilot will report itself unavailable');
  }

  // --- everything else --------------------------------------------------------
  if (production && env.JOBS_ENABLED === 'false') {
    // Legitimate on a second instance â€” exactly one process should own the schedule â€” so
    // this only ever tells the reader what to expect, in case it was not deliberate.
    warn(
      'JOBS_ENABLED',
      'is false, so this process sends no scheduled notifications. Correct for an extra instance; check that another one does',
    );
  }
  if (production && (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace')) {
    warn(
      'LOG_LEVEL',
      'is more verbose than production wants: these levels log request bodies and headers, which is where session cookies and Copilot content live',
    );
  }
  if (env.TRUST_PROXY !== undefined && trustProxySetting(env) === null) {
    fatal(
      'TRUST_PROXY',
      'is not a value this server accepts: use true, false, or a comma-separated list of trusted proxy addresses or CIDR ranges. A bare hop count is rejected deliberately â€” see lib/config-audit.ts',
    );
  }

  return findings;
}

/**
 * How much of X-Forwarded-For to believe, if any.
 *
 * Off unless configured, and that default is the security-relevant half of this function.
 * With it on, Fastify takes the client address from a header the client itself can write â€”
 * which is correct behind a proxy that overwrites it, and a free identity spoof for
 * anything that rate limits by IP the moment the API is reachable directly. Since only the
 * operator knows which of the two they have deployed, only the operator can turn it on.
 *
 * A bare hop count is refused rather than passed through. Fastify accepts a number and then
 * ignores it: `getTrustProxyFn` in fastify/lib/request.js answers `() => false` for any
 * number, because counting hops cannot validate the immediate peer. So `TRUST_PROXY=1`
 * would read as "trust one proxy" and behave as "trust nothing" â€” every request attributed
 * to nginx's address, every per-IP limit collapsed into one shared counter, and no error to
 * say so. Naming the address or CIDR range is the form that works.
 *
 * Returns null when the value is set but unusable, so the audit above can refuse it rather
 * than let Fastify interpret `TRUST_PROXY=maybe` as a hostname.
 */
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): boolean | string[] | null {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return null;
  // A list of addresses or CIDR ranges. Anything with a comma or a dot or a colon is
  // plausibly one; a bare word like `yes` is a typo for `true` and should be caught.
  const entries = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const looksLikeAddress = (value: string) => /^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(value);
  return entries.every(looksLikeAddress) ? entries : null;
}

/**
 * Log the findings, then stop the boot if any of them were fatal.
 *
 * The throw is the point. This runs before the server listens, so a fatal finding means no
 * port is opened, the container healthcheck never passes, and a deployment that would have
 * been exploitable is a deployment that visibly failed instead.
 */
export function reportConfig(
  findings: Finding[],
  log: { warn: (message: string) => void; error: (message: string) => void },
): void {
  for (const finding of findings) {
    const line = `config: ${finding.setting} ${finding.message}`;
    if (finding.severity === 'fatal') log.error(line);
    else log.warn(line);
  }

  const fatalities = findings.filter((finding) => finding.severity === 'fatal');
  if (fatalities.length === 0) return;
  throw new Error(
    `Refusing to start: ${fatalities.length} fatal configuration problem${
      fatalities.length === 1 ? '' : 's'
    } (${fatalities.map((finding) => finding.setting).join(', ')}). See the log above.`,
  );
}
