/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage, DeltaChat) use their own ID
 * formats and send them as-is — no channel prefix. WhatsApp/iMessage emit
 * JIDs/emails containing '@'. Signal emits raw phone numbers ('+15551234567')
 * for DMs and 'group:<id>' for group chats. DeltaChat emits numeric chat IDs
 * ('12'). Prefixing any of these would cause a mismatch with what the adapter
 * later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  if (channel === 'deltachat') return raw;
  return `${channel}:${raw}`;
}

/**
 * Validate that a platform_id is structurally well-formed for its channel,
 * throwing an actionable error if not. Run this at the boundaries where an
 * operator hand-supplies a platform_id (e.g. init-first-agent) so a typo
 * fails loudly at wiring time instead of silently 404-ing on every send.
 *
 * Currently enforces Discord's `discord:<guildId>:<channelId>` shape, where
 * guildId is `@me` (DM / group DM) or a numeric snowflake and channelId is a
 * numeric snowflake. This catches the common mistake of passing a *user* id
 * as the DM target (e.g. `discord:dm:<userId>`), which Discord rejects with
 * "Unknown Channel" (10003) — a DM channel id must come from
 * `POST /users/@me/channels`, it is NOT the user's id. Channels not listed
 * here pass through unchecked: native adapters use their own id formats and
 * this validator only knows the ones it lists.
 */
export function assertValidPlatformId(channel: string, platformId: string): void {
  if (channel === 'discord') {
    const parts = platformId.split(':');
    const wellFormed =
      parts.length === 3 &&
      parts[0] === 'discord' &&
      (parts[1] === '@me' || /^\d+$/.test(parts[1])) &&
      /^\d+$/.test(parts[2]);
    if (!wellFormed) {
      throw new Error(
        `Malformed Discord platform_id "${platformId}". Expected "discord:@me:<dmChannelId>" for a DM ` +
          `or "discord:<guildId>:<channelId>" for a guild channel, where the ids are numeric snowflakes. ` +
          `A DM channel id comes from POST /users/@me/channels — it is not your user id.`,
      );
    }
  }
}
