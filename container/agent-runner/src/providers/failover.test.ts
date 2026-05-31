import { describe, expect, it } from 'bun:test';

import { otherProvider, shouldFailover } from './failover.js';

describe('otherProvider', () => {
  it('maps codex<->claude both ways', () => {
    expect(otherProvider('codex')).toBe('claude');
    expect(otherProvider('claude')).toBe('codex');
  });

  it('is case-insensitive', () => {
    expect(otherProvider('Codex')).toBe('claude');
    expect(otherProvider('CLAUDE')).toBe('codex');
  });

  it('returns null for providers with no failover partner', () => {
    expect(otherProvider('mock')).toBeNull();
    expect(otherProvider('opencode')).toBeNull();
  });
});

describe('shouldFailover', () => {
  it('is true for outage reasons', () => {
    for (const r of ['auth-expired', 'usage-exhausted', 'rate-limit', 'overloaded', 'network-error'] as const) {
      expect(shouldFailover(r)).toBe(true);
    }
  });

  it('is false for none (timeouts, unknown, retryable all map to none)', () => {
    expect(shouldFailover('none')).toBe(false);
  });
});
