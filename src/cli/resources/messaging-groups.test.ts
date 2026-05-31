/**
 * Regression test: `ncl messaging-groups create` must reject a malformed
 * Discord platform_id (e.g. a bare channel snowflake "1510320250816823386"
 * with no "discord:<guildId>:<channelId>" encoding). Stored unvalidated such
 * a row is undeliverable — the adapter's decodeThreadId throws on every send,
 * so the channel silently never receives anything. This is the exact shape
 * that broke a "scrap → registered channel" destination in production.
 *
 * The validation lives in the resource's `validate` hook (src/cli/crud.ts),
 * so it covers the agent/operator path that goes through dispatch — the only
 * way a hand-supplied platform_id reaches storage.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `messaging-groups-create` command.
import './messaging-groups.js';

async function create(args: Record<string, unknown>) {
  // caller: 'host' runs the real handler (bypasses the approval gate the same
  // way dispatch re-enters after an admin approves).
  return dispatch({ id: 'req', command: 'messaging-groups-create', args }, { caller: 'host' });
}

describe('messaging-groups create validates platform_id', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('rejects a bare Discord channel snowflake (the production bug shape)', async () => {
    const resp = await create({ channel_type: 'discord', platform_id: '1510320250816823386' });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toMatch(/Malformed Discord/);
    }
    // Nothing should have been persisted.
    expect(getMessagingGroupByPlatform('discord', '1510320250816823386')).toBeUndefined();
  });

  it('accepts a properly encoded guild channel id', async () => {
    const resp = await create({
      channel_type: 'discord',
      platform_id: 'discord:1496311238483771402:1510320250816823386',
      is_group: 1,
    });

    expect(resp.ok).toBe(true);
    const mg = getMessagingGroupByPlatform('discord', 'discord:1496311238483771402:1510320250816823386');
    expect(mg).toBeDefined();
  });

  it('accepts a properly encoded DM channel id', async () => {
    const resp = await create({
      channel_type: 'discord',
      platform_id: 'discord:@me:1510271123273551903',
    });

    expect(resp.ok).toBe(true);
  });

  it('passes through non-Discord channels unchecked', async () => {
    const resp = await create({ channel_type: 'telegram', platform_id: 'telegram:6037840640' });

    expect(resp.ok).toBe(true);
  });
});
