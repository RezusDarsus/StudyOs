// HS256 JWT signing. Signing only, and deliberately without a library.
//
// The dangerous half of JWT is verification: algorithm confusion (honouring `alg: none`,
// or accepting an RS256 *public* key as an HMAC secret), forgetting to check `exp`,
// comparing signatures with `===`. A library earns its keep there, and it would be
// reckless to hand-roll it.
//
// Nothing in this codebase verifies a JWT. Sessions are opaque random tokens hashed in
// the database (see lib/auth.ts) precisely so that no request depends on us validating a
// signature. The only tokens produced here are handed to Centrifugo, which verifies them
// with its own implementation against a secret we share with it. What remains on this
// side is two base64url segments and one HMAC — less code than the dependency that would
// hide it, and auditable in one screen.

import { createHmac } from 'node:crypto';

const segment = (value: object) =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/**
 * Sign a claim set as a compact JWS with HMAC-SHA256.
 *
 * The header is fixed rather than caller-supplied: there is exactly one algorithm in
 * use, and an `alg` that can be influenced from outside is the root of the whole family
 * of JWT vulnerabilities.
 */
export function signHs256(claims: Record<string, unknown>, secret: string): string {
  if (!secret) throw new Error('signHs256 requires a secret');
  const signingInput = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}
