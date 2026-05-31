import { assertValidPlatformId } from '../../platform-id.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'messaging-group',
  plural: 'messaging-groups',
  table: 'messaging_groups',
  // Reject a malformed platform_id at create time (e.g. a bare Discord channel
  // snowflake instead of the "discord:<guildId>:<channelId>" encoding). Stored
  // unvalidated, such a row is undeliverable — the adapter's decodeThreadId
  // throws on every send so the channel silently never receives anything.
  validate: (v) => assertValidPlatformId(String(v.channel_type), String(v.platform_id)),
  description:
    'Messaging group — one chat or channel on one platform (a Telegram DM, a Discord channel, a Slack thread root, an email address). Identity is the (channel_type, platform_id) pair, which must be unique.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'channel_type',
      type: 'string',
      description:
        'Channel adapter type — matches the adapter registered by /add-<channel> (e.g. telegram, discord, slack, whatsapp).',
      required: true,
    },
    {
      name: 'platform_id',
      type: 'string',
      description:
        'Platform-specific chat ID. Format varies: Telegram chat ID, Discord channel snowflake, Slack channel ID, phone number, email address.',
      required: true,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Display name. Often auto-populated by the channel adapter.',
      updatable: true,
    },
    {
      name: 'is_group',
      type: 'number',
      description: 'Multi-user group chat (1) or direct message (0). Affects session scoping.',
      default: 0,
      updatable: true,
    },
    {
      name: 'unknown_sender_policy',
      type: 'string',
      description:
        'What happens when an unrecognized sender posts. "strict" drops silently. "request_approval" sends an approval card to an admin. "public" allows anyone.',
      enum: ['strict', 'request_approval', 'public'],
      default: 'strict',
      updatable: true,
    },
    {
      name: 'denied_at',
      type: 'string',
      description:
        'Set when the owner explicitly denies registering this channel. While set, the router drops all messages silently without re-escalating. Cleared by any explicit wiring mutation.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
});
