import { describe, it, expect } from 'vitest';

import { assertValidPlatformId, namespacedPlatformId } from './platform-id.js';

describe('namespacedPlatformId', () => {
  it('prefixes a bare id with the channel', () => {
    expect(namespacedPlatformId('telegram', '123456')).toBe('telegram:123456');
  });

  it('leaves an already-prefixed id alone', () => {
    expect(namespacedPlatformId('discord', 'discord:@me:42')).toBe('discord:@me:42');
  });

  it('leaves native id formats unprefixed', () => {
    expect(namespacedPlatformId('whatsapp', '15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(namespacedPlatformId('signal', '+15551234567')).toBe('+15551234567');
    expect(namespacedPlatformId('deltachat', '12')).toBe('12');
  });
});

describe('assertValidPlatformId', () => {
  it('accepts a well-formed Discord DM id', () => {
    expect(() => assertValidPlatformId('discord', 'discord:@me:1510271123273551903')).not.toThrow();
  });

  it('accepts a well-formed Discord guild channel id', () => {
    expect(() => assertValidPlatformId('discord', 'discord:1496311238483771402:1510270210983329862')).not.toThrow();
  });

  it('rejects the dm:<userId> footgun that 404s on every send', () => {
    expect(() => assertValidPlatformId('discord', 'discord:dm:303155179769823232')).toThrow(
      /Unknown Channel|Malformed Discord/,
    );
  });

  it('rejects a non-numeric channel segment', () => {
    expect(() => assertValidPlatformId('discord', 'discord:@me:not-a-snowflake')).toThrow(/Malformed Discord/);
  });

  it('rejects a missing channel segment', () => {
    expect(() => assertValidPlatformId('discord', 'discord:@me')).toThrow(/Malformed Discord/);
  });

  it('passes through channels it does not know about', () => {
    expect(() => assertValidPlatformId('telegram', 'telegram:6037840640')).not.toThrow();
    expect(() => assertValidPlatformId('signal', '+15551234567')).not.toThrow();
  });
});
