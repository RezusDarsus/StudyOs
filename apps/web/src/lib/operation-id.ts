/**
 * Stage 4: one stable operation token per user action.
 *
 * The client generates it once when the user initiates an action and reuses it
 * verbatim on network retries; the server derives its own idempotency key from
 * it, so a request that committed but whose response was lost replays instead
 * of mutating twice.
 */
export function newOperationId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
