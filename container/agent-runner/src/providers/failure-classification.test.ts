import { describe, expect, it } from 'bun:test';

import { classifyProviderFailure } from './failure-classification.js';

describe('classifyProviderFailure', () => {
  it('classifies auth / 401 failures', () => {
    expect(classifyProviderFailure({ errorText: 'API Error: 401 Unauthorized' })).toBe('auth-expired');
    expect(classifyProviderFailure({ errorText: 'OAuth token has expired' })).toBe('auth-expired');
    expect(classifyProviderFailure({ errorText: 'authentication_error: invalid x' })).toBe('auth-expired');
    // codex turn/failed style
    expect(classifyProviderFailure({ errorText: 'turn failed: 401 unauthorized' })).toBe('auth-expired');
    expect(classifyProviderFailure({ errorText: 'Your org does not have access to Claude. Please login again.' })).toBe(
      'auth-expired',
    );
  });

  it('classifies usage / quota exhaustion', () => {
    expect(classifyProviderFailure({ errorText: "You're out of extra usage. Resets at 5pm." })).toBe('usage-exhausted');
    expect(classifyProviderFailure({ errorText: 'usage limit reached' })).toBe('usage-exhausted');
    expect(classifyProviderFailure({ errorText: 'exceeded your current quota' })).toBe('usage-exhausted');
    // Claude rate_limit_event surfaces classification='quota'
    expect(classifyProviderFailure({ errorText: 'Rate limit', classification: 'quota' })).toBe('usage-exhausted');
  });

  it('classifies 429 rate limits', () => {
    expect(classifyProviderFailure({ errorText: 'API Error: 429 Too Many Requests' })).toBe('rate-limit');
    expect(classifyProviderFailure({ errorText: 'rate-limit exceeded' })).toBe('rate-limit');
  });

  it('classifies overload / 503', () => {
    expect(classifyProviderFailure({ errorText: 'API Error: 503 overloaded' })).toBe('overloaded');
    expect(classifyProviderFailure({ errorText: 'service unavailable' })).toBe('overloaded');
  });

  it('classifies network errors', () => {
    expect(classifyProviderFailure({ errorText: 'fetch failed' })).toBe('network-error');
    expect(classifyProviderFailure({ errorText: 'read ECONNRESET' })).toBe('network-error');
    expect(classifyProviderFailure({ errorText: 'getaddrinfo ENOTFOUND api.anthropic.com' })).toBe('network-error');
  });

  it('does NOT fail over on retryable events (SDK self-heals)', () => {
    expect(classifyProviderFailure({ errorText: 'API retry', retryable: true })).toBe('none');
    // retryable wins even if the text looks like a 429
    expect(classifyProviderFailure({ errorText: '429 slow down', retryable: true })).toBe('none');
  });

  it('treats turn timeout as out of scope (not an outage)', () => {
    expect(classifyProviderFailure({ errorText: 'Turn timed out after 900000ms' })).toBe('none');
  });

  it('returns none for unrecognized / empty errors', () => {
    expect(classifyProviderFailure({ errorText: 'something weird happened' })).toBe('none');
    expect(classifyProviderFailure({ errorText: '' })).toBe('none');
  });

  it('applies priority auth > usage > 429 > overloaded > network', () => {
    // contains both 401 and 429 → auth wins
    expect(classifyProviderFailure({ errorText: '401 unauthorized; also 429' })).toBe('auth-expired');
    // contains both quota and 429 → usage wins
    expect(classifyProviderFailure({ errorText: 'quota exceeded (429)' })).toBe('usage-exhausted');
  });
});
