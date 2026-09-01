import type { CapabilityFailure } from './types.js';
import { HttpError } from '../lib/errors.js';

/**
 * Typed capability failure — the only error type that crosses the executor's
 * boundary as a *result* (not an exception) for expected outcomes. Business
 * rule errors from wrapped services keep their own types and surface as
 * CAPABILITY_EXECUTION_FAILED with the original code preserved in details.
 */
export class CapabilityError extends Error implements CapabilityFailure {
  readonly code: CapabilityFailure['code'];
  readonly repairableByModel: boolean;
  readonly requiresUserClarification: boolean;
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CapabilityFailure['code'],
    message: string,
    opts: {
      repairableByModel?: boolean;
      requiresUserClarification?: boolean;
      details?: Record<string, unknown>;
      statusCode?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CapabilityError';
    this.code = code;
    this.repairableByModel = opts.repairableByModel ?? false;
    this.requiresUserClarification = opts.requiresUserClarification ?? false;
    this.details = opts.details;
    // HTTP convention: authorization/validation failures are 4xx; execution
    // failures are 503 (retryable) unless the wrapped service set its own code.
    this.statusCode =
      opts.statusCode ??
      (code === 'CAPABILITY_FORBIDDEN' ? 403
        : code === 'CAPABILITY_TARGET_NOT_FOUND' ? 404
          : code === 'CAPABILITY_IDEMPOTENCY_CONFLICT' || code === 'CAPABILITY_CONFIRMATION_REQUIRED'
            || code === 'CAPABILITY_STALE' || code === 'CAPABILITY_TARGET_AMBIGUOUS' ? 409
            : code === 'CAPABILITY_EXECUTION_FAILED' ? 503
              : 400);
  }

  /** Convert to the application's HttpError convention for route mapping. */
  toHttpError(): HttpError {
    return new HttpError(this.statusCode, this.message, this.code);
  }
}

export const capabilityUnknown = (name: string) =>
  new CapabilityError('CAPABILITY_UNKNOWN', 'That action is not available.', { details: { capability: name } });

export const capabilityInputInvalid = (message: string, details?: Record<string, unknown>) =>
  new CapabilityError('CAPABILITY_INPUT_INVALID', message, { repairableByModel: true, details });

export const capabilityTargetNotFound = (message: string) =>
  new CapabilityError('CAPABILITY_TARGET_NOT_FOUND', message, { requiresUserClarification: true });

export const capabilityTargetAmbiguous = (message: string, details?: Record<string, unknown>) =>
  new CapabilityError('CAPABILITY_TARGET_AMBIGUOUS', message, { requiresUserClarification: true, details });

export const capabilityForbidden = (message = 'You do not have access to this') =>
  new CapabilityError('CAPABILITY_FORBIDDEN', message);

export const capabilityStale = (message: string) =>
  new CapabilityError('CAPABILITY_STALE', message);

export const capabilityExecutionFailed = (message: string, details?: Record<string, unknown>) =>
  new CapabilityError('CAPABILITY_EXECUTION_FAILED', message, { details });
