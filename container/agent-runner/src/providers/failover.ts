/**
 * Bidirectional provider failover policy.
 *
 * Decides (a) which provider takes over when one fails, and (b) which failure
 * reasons warrant a takeover. The poll-loop owns the mechanics (re-running the
 * turn, the "no visible output yet" guard, the one-failover-per-turn cap); this
 * module is just the policy.
 */
import type { ProviderName } from './factory.js';
import type { FailureReason } from './failure-classification.js';

/**
 * Map a provider to its failover partner. Only the codex<->claude pair is
 * wired — any other provider (mock, opencode, …) returns null so no failover
 * is attempted for it.
 */
export function otherProvider(name: ProviderName): ProviderName | null {
  switch (name.toLowerCase()) {
    case 'codex':
      return 'claude';
    case 'claude':
      return 'codex';
    default:
      return null;
  }
}

/** Reasons that warrant switching to the other provider (outages only). */
const FAILOVER_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'auth-expired',
  'usage-exhausted',
  'rate-limit',
  'overloaded',
  'network-error',
]);

export function shouldFailover(reason: FailureReason): boolean {
  return FAILOVER_REASONS.has(reason);
}
