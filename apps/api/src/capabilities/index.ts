import { registerCapability, capabilityRegistry } from './registry.js';
import {
  applyAiEditCapability,
  applyManualEditCapability,
  confirmFromDraftCapability,
  proposeProgressionCapability,
} from './definitions/goal.js';
import { correctConsumptionCapability, markConsumedCapability } from './definitions/recommendation.js';

/**
 * THE capability composition root (Stage 4).
 *
 * Static, trusted, server-side registrations — the model and the user cannot
 * add, remove, or rewire a capability. Duplicate names throw here, at boot.
 * Call this exactly once at startup (server.ts does; the acceptance harness
 * does for its in-process server).
 */
let registered = false;

export function registerCapabilities(): void {
  if (registered) return;
  registerCapability(confirmFromDraftCapability);
  registerCapability(applyAiEditCapability);
  registerCapability(applyManualEditCapability);
  registerCapability(markConsumedCapability);
  registerCapability(correctConsumptionCapability);
  registerCapability(proposeProgressionCapability);
  registered = true;
}

/** Test/diagnostic helper: how many capabilities are registered. */
export function registeredCount(): number {
  return capabilityRegistry.size;
}
