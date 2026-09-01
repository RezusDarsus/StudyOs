import { describe, expect, it, vi } from 'vitest';
import { auditConfig, reportConfig, trustProxySetting, type Finding } from './config-audit.js';

/** A production environment with nothing wrong with it, as the baseline to break. */
const sound: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://goalify:aV3ryRealPassword@postgres:5432/goalify?schema=public',
  WEB_ORIGIN: 'https://goalify.app',
  CENTRIFUGO_URL: 'http://centrifugo:8000',
  CENTRIFUGO_API_KEY: '2f7c1e2b9a4d',
  CENTRIFUGO_TOKEN_HMAC_SECRET: '9d3b7f0a15ce',
  NVIDIA_API_KEY: 'nvapi-real',
};

const at = (findings: Finding[], setting: string) =>
  findings.filter((finding) => finding.setting === setting);

describe('auditConfig', () => {
  it('finds nothing wrong with a sound production environment', () => {
    expect(auditConfig(sound)).toEqual([]);
  });

  it('accepts a development environment with almost nothing set', () => {
    // Every fatal rule is conditional on production, so a fresh clone running `npm run dev`
    // must not be told it has a security problem.
    const findings = auditConfig({ NODE_ENV: 'development', DATABASE_URL: 'file:./dev.db' });
    expect(findings.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  describe('removed Copilot feature flags (Stage 6)', () => {
    it('a stray flag value in the environment is inert — no rule reads it', () => {
      // The six staging flags are deleted; a leftover value in a deployed
      // .env must neither warn nor change behavior. The audit has no rule
      // for any of them, which is the proof of removal.
      const stray: NodeJS.ProcessEnv = {
        ...sound,
        COPILOT_STRUCTURED_RECOMMENDATIONS: '1',
        COPILOT_RECOMMENDATION_HISTORY_V2_WRITE_MODE: 'eager',
        COPILOT_RECOMMENDATION_HISTORY_V2_READ: '1',
        COPILOT_RUNTIME_DOMAIN_CONTENT: '1',
        COPILOT_CAPABILITY_REGISTRY: '1',
        COPILOT_REQUIREMENT_AST: '1',
      };
      expect(auditConfig(stray)).toEqual([]);
    });
  });

  describe('CORS', () => {
    it('refuses a wildcard origin', () => {
      const findings = at(auditConfig({ ...sound, WEB_ORIGIN: '*' }), 'WEB_ORIGIN');
      expect(findings[0]?.severity).toBe('fatal');
      expect(findings[0]?.message).toContain('wildcard');
    });

    it('refuses a wildcard hidden in a list of good origins', () => {
      const findings = at(
        auditConfig({ ...sound, WEB_ORIGIN: 'https://goalify.app, *' }),
        'WEB_ORIGIN',
      );
      expect(findings[0]?.severity).toBe('fatal');
    });

    it('refuses an origin with no scheme', () => {
      const findings = at(auditConfig({ ...sound, WEB_ORIGIN: 'goalify.app' }), 'WEB_ORIGIN');
      expect(findings[0]?.severity).toBe('fatal');
      expect(findings[0]?.message).toContain('absolute origin');
    });

    it('refuses an origin with a trailing path, which would never match', () => {
      const findings = at(auditConfig({ ...sound, WEB_ORIGIN: 'https://goalify.app/' }), 'WEB_ORIGIN');
      expect(findings[0]?.severity).toBe('fatal');
      // The message says what to write instead, because "this is wrong" is half an answer.
      expect(findings[0]?.message).toContain('https://goalify.app');
    });

    it('refuses the forms the URL parser normalises away', () => {
      // Each of these looks right and matches nothing: the browser sends the normalised
      // origin, and @fastify/cors compares strings.
      for (const origin of [
        'https://goalify.app:443',
        'https://GOALIFY.app',
        'https://goalify.app/api',
      ]) {
        const findings = at(auditConfig({ ...sound, WEB_ORIGIN: origin }), 'WEB_ORIGIN');
        expect(findings[0]?.severity, origin).toBe('fatal');
      }
    });

    it('accepts a non-default port, which is part of the origin', () => {
      expect(auditConfig({ ...sound, WEB_ORIGIN: 'https://goalify.app:8443' })).toEqual([]);
    });

    it('accepts a port and a comma-separated list', () => {
      expect(
        auditConfig({ ...sound, WEB_ORIGIN: 'http://localhost:5173,http://localhost:5174' }),
      ).toEqual([]);
    });

    it('warns that a plain-http production origin will not carry the session cookie', () => {
      const findings = at(auditConfig({ ...sound, WEB_ORIGIN: 'http://goalify.app' }), 'WEB_ORIGIN');
      expect(findings[0]?.severity).toBe('warning');
      expect(findings[0]?.message).toContain('Secure');
    });

    it('says nothing about plain http on loopback, which browsers treat as secure', () => {
      expect(auditConfig({ ...sound, WEB_ORIGIN: 'http://localhost:8080' })).toEqual([]);
    });

    it('warns rather than refuses when it is missing, because that fails closed', () => {
      const findings = at(auditConfig({ ...sound, WEB_ORIGIN: undefined }), 'WEB_ORIGIN');
      expect(findings[0]?.severity).toBe('warning');
    });
  });

  describe('secrets', () => {
    // The distinction that matters: a known Centrifugo secret is a remote authorisation
    // bypass, so it stops the boot. A known database password behind loopback is a
    // weakness, so it is reported and tolerated.
    it('refuses a placeholder realtime secret', () => {
      const findings = at(
        auditConfig({ ...sound, CENTRIFUGO_TOKEN_HMAC_SECRET: 'replace-me' }),
        'CENTRIFUGO_TOKEN_HMAC_SECRET',
      );
      expect(findings[0]?.severity).toBe('fatal');
    });

    it('refuses a placeholder API key, whatever its case or padding', () => {
      const findings = at(
        auditConfig({ ...sound, CENTRIFUGO_API_KEY: '  Change-Me  ' }),
        'CENTRIFUGO_API_KEY',
      );
      expect(findings[0]?.severity).toBe('fatal');
    });

    it('only warns about a placeholder database password', () => {
      const findings = at(
        auditConfig({
          ...sound,
          DATABASE_URL: 'postgresql://goalify:replace-me@postgres:5432/goalify',
        }),
        'DATABASE_URL',
      );
      expect(findings[0]?.severity).toBe('warning');
    });

    it('never repeats a value it is complaining about', () => {
      const findings = auditConfig({
        ...sound,
        DATABASE_URL: 'postgresql://goalify:hunter2@postgres:5432/goalify',
        CENTRIFUGO_TOKEN_HMAC_SECRET: 'replace-me',
        LOG_LEVEL: 'debug',
      });
      const text = JSON.stringify(findings);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('postgresql://');
    });
  });

  describe('the database', () => {
    it('refuses to start without one', () => {
      const findings = at(auditConfig({ ...sound, DATABASE_URL: undefined }), 'DATABASE_URL');
      expect(findings[0]?.severity).toBe('fatal');
    });

    it('refuses one that is not a URL', () => {
      const findings = at(auditConfig({ ...sound, DATABASE_URL: 'goalify' }), 'DATABASE_URL');
      expect(findings[0]?.severity).toBe('fatal');
    });
  });

  describe('realtime', () => {
    it('says nothing when realtime is switched off entirely', () => {
      expect(
        auditConfig({
          ...sound,
          CENTRIFUGO_URL: undefined,
          CENTRIFUGO_API_KEY: undefined,
          CENTRIFUGO_TOKEN_HMAC_SECRET: undefined,
        }),
      ).toEqual([]);
    });

    it('warns when it is half configured, which looks like working software', () => {
      const findings = auditConfig({ ...sound, CENTRIFUGO_TOKEN_HMAC_SECRET: undefined });
      expect(findings.some((finding) => finding.message.includes('partly configured'))).toBe(true);
      expect(findings.every((finding) => finding.severity === 'warning')).toBe(true);
    });
  });

  describe('the rest', () => {
    it('warns about a missing AI key without refusing to start', () => {
      const findings = at(auditConfig({ ...sound, NVIDIA_API_KEY: '' }), 'NVIDIA_API_KEY');
      expect(findings[0]?.severity).toBe('warning');
    });

    it('says nothing about a missing NVIDIA key when the provider is something else', () => {
      expect(
        auditConfig({ ...sound, AI_PROVIDER: 'mock', NVIDIA_API_KEY: undefined }),
      ).toEqual([]);
    });

    it('warns when this process will send no scheduled notifications', () => {
      const findings = at(auditConfig({ ...sound, JOBS_ENABLED: 'false' }), 'JOBS_ENABLED');
      expect(findings[0]?.severity).toBe('warning');
    });

    it('warns about a log level that records request bodies in production', () => {
      expect(at(auditConfig({ ...sound, LOG_LEVEL: 'debug' }), 'LOG_LEVEL')).toHaveLength(1);
      expect(at(auditConfig({ ...sound, LOG_LEVEL: 'info' }), 'LOG_LEVEL')).toHaveLength(0);
    });

    it('refuses a TRUST_PROXY value Fastify would misread', () => {
      const findings = at(auditConfig({ ...sound, TRUST_PROXY: 'yes' }), 'TRUST_PROXY');
      expect(findings[0]?.severity).toBe('fatal');
    });

    it('refuses a hop count, which would silently trust nothing', () => {
      const findings = at(auditConfig({ ...sound, TRUST_PROXY: '1' }), 'TRUST_PROXY');
      expect(findings[0]?.severity).toBe('fatal');
    });

    it('accepts the proxy address form', () => {
      expect(at(auditConfig({ ...sound, TRUST_PROXY: '172.19.0.0/16' }), 'TRUST_PROXY')).toEqual(
        [],
      );
    });
  });
});

describe('trustProxySetting', () => {
  it('is off when unset, so X-Forwarded-For is never believed by default', () => {
    expect(trustProxySetting({})).toBe(false);
    expect(trustProxySetting({ TRUST_PROXY: '' })).toBe(false);
  });

  it('reads the booleans', () => {
    expect(trustProxySetting({ TRUST_PROXY: 'true' })).toBe(true);
    expect(trustProxySetting({ TRUST_PROXY: 'false' })).toBe(false);
  });

  it('refuses a hop count, which Fastify accepts and then ignores', () => {
    // Fastify answers `() => false` for any numeric trustProxy, so `1` would read as
    // "trust one proxy" and behave as "trust nothing". Better to refuse it than to let
    // an operator believe X-Forwarded-For is being read when it is not.
    expect(trustProxySetting({ TRUST_PROXY: '1' })).toBe(null);
    expect(trustProxySetting({ TRUST_PROXY: '0' })).toBe(null);
  });

  it('reads an address list', () => {
    expect(trustProxySetting({ TRUST_PROXY: '172.19.0.0/16, 10.0.0.1' })).toEqual([
      '172.19.0.0/16',
      '10.0.0.1',
    ]);
  });

  it('rejects a word that is not a value', () => {
    expect(trustProxySetting({ TRUST_PROXY: 'yes' })).toBe(null);
    expect(trustProxySetting({ TRUST_PROXY: 'nginx' })).toBe(null);
  });
});

describe('reportConfig', () => {
  const logger = () => ({ warn: vi.fn(), error: vi.fn() });

  it('logs warnings and returns', () => {
    const log = logger();
    reportConfig([{ severity: 'warning', setting: 'NVIDIA_API_KEY', message: 'is not set' }], log);
    expect(log.warn).toHaveBeenCalledWith('config: NVIDIA_API_KEY is not set');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('throws on a fatal finding, naming the settings', () => {
    const log = logger();
    expect(() =>
      reportConfig(
        [
          { severity: 'fatal', setting: 'WEB_ORIGIN', message: 'is a wildcard' },
          { severity: 'warning', setting: 'LOG_LEVEL', message: 'is verbose' },
          { severity: 'fatal', setting: 'DATABASE_URL', message: 'is not set' },
        ],
        log,
      ),
    ).toThrow(/2 fatal configuration problems \(WEB_ORIGIN, DATABASE_URL\)/);
    // Every finding is logged before the throw, including the warning it did not stop for.
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when there is nothing to say', () => {
    const log = logger();
    reportConfig([], log);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
