/**
 * Provider failure classification (SSOT).
 *
 * Classifies a provider failure — surfaced either as a thrown exception or as
 * a `{type:'error'}` ProviderEvent — into a coarse reason used to decide
 * whether to fail over to the other provider. Adapted from EJClaw's agent
 * error detection, narrowed to the failure modes we fail over on.
 *
 * Scope: real provider OUTAGES only. Turn timeouts and normal empty results
 * are NOT failures here — a timeout means "slow", and the alternate provider
 * may be slow too, so switching wouldn't help.
 *
 * NOTE: codex surfaces failures via the app-server's `turn/failed` message
 * (`params.error.message`); claude surfaces transient ones as `{type:'error'}`
 * events (`api_retry` retryable, `rate_limit_event` classification='quota')
 * and hard ones as thrown SDK exceptions. The regexes below cover the common
 * vocabulary of both; tune against real samples as they show up in logs.
 */

export type FailureReason =
  | 'auth-expired' // 401 / token expired / unauthorized / org access denied
  | 'usage-exhausted' // plan or quota exhausted ("out of usage", quota)
  | 'rate-limit' // 429 / too many requests
  | 'overloaded' // 503 / overloaded / service unavailable
  | 'network-error' // fetch failed / ECONNRESET / DNS / socket
  | 'none'; // not a failover-worthy failure

const AUTH_RE =
  /\b401\b|unauthorized|authentication[_\s-]?error|oauth token has expired|invalid authentication|does not have access to claude|please login again|obtain a new token/i;
const USAGE_RE =
  /out of (?:extra )?usage|usage limit|insufficient_quota|\bquota\b|hit your limit|plan limit|exceeded your (?:current )?quota/i;
const RATE_RE = /\b429\b|rate[_\s-]?limit|too many requests/i;
const OVERLOADED_RE = /\b503\b|overloaded|server is overloaded|service unavailable|temporarily unavailable/i;
const NETWORK_RE =
  /fetch failed|network error|econnreset|etimedout|enotfound|socket hang up|connection (?:reset|refused|closed)|getaddrinfo/i;
// Turn timeout is explicitly OUT of scope (a slow turn, not an outage).
const TIMEOUT_RE = /turn timed out|timed out after/i;

export interface FailureSignal {
  /** Exception message or `{type:'error'}` event message. */
  errorText: string;
  /** Optional classification hint from a provider event (e.g. 'quota'). */
  classification?: string;
  /**
   * `retryable` flag from a `{type:'error'}` event. When true the underlying
   * SDK is self-healing (e.g. Claude `api_retry`) and we must NOT fail over.
   */
  retryable?: boolean;
}

/**
 * Map a failure signal to a coarse reason. Returns 'none' when the signal is
 * not a provider outage we fail over on (retryable, timeout, or unrecognized).
 */
export function classifyProviderFailure(signal: FailureSignal): FailureReason {
  // SDK is retrying on its own — not our cue to switch providers.
  if (signal.retryable === true) return 'none';

  const text = (signal.errorText || '').toLowerCase();

  // Provider-supplied hint wins for the quota case (Claude rate_limit_event).
  if ((signal.classification || '').toLowerCase() === 'quota') return 'usage-exhausted';

  // A slow turn is not an outage — exclude before pattern matching.
  if (TIMEOUT_RE.test(text)) return 'none';

  // Priority: auth > usage > 429 > overloaded > network.
  if (AUTH_RE.test(text)) return 'auth-expired';
  if (USAGE_RE.test(text)) return 'usage-exhausted';
  if (RATE_RE.test(text)) return 'rate-limit';
  if (OVERLOADED_RE.test(text)) return 'overloaded';
  if (NETWORK_RE.test(text)) return 'network-error';

  return 'none';
}
