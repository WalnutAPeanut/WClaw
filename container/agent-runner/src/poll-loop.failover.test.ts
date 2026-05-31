/**
 * Integration coverage for the failover-facing half of the poll-loop:
 * `runTurnAttempt` normalizes both failure channels (a `{type:'error'}` outage
 * event and a thrown exception) into a uniform AttemptOutcome with a classified
 * reason and the `sawVisibleOutput` guard. The reason + guard are exactly what
 * runPollLoop checks before handing the turn to the partner provider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb } from './db/connection.js';
import { runTurnAttempt } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});
afterEach(() => {
  closeSessionDb();
});

const ROUTING: RoutingContext = { platformId: 'p', channelType: 'discord', threadId: null, inReplyTo: null };

/** Build a provider that yields a fixed event script, or throws. */
function scriptedProvider(script: ProviderEvent[] | { throw: string }): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query(_input: QueryInput): AgentQuery {
      let aborted = false;
      async function* gen(): AsyncGenerator<ProviderEvent> {
        if (!Array.isArray(script)) throw new Error(script.throw);
        for (const e of script) {
          if (aborted) return;
          yield e;
        }
      }
      return { push() {}, end() {}, abort() { aborted = true; }, events: gen() };
    },
  };
}

function attempt(provider: AgentProvider) {
  return runTurnAttempt(provider, 'codex', 'hi', undefined, '/tmp', undefined, ROUTING, []);
}

describe('runTurnAttempt — failure normalization', () => {
  it('ok when the turn produces a result', async () => {
    const out = await attempt(
      scriptedProvider([
        { type: 'init', continuation: 'sess-1' },
        { type: 'result', text: null },
      ]),
    );
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.continuation).toBe('sess-1');
  });

  it('failed with classified reason on an outage error event (no result after)', async () => {
    const out = await attempt(
      scriptedProvider([{ type: 'error', message: 'API Error: 429 Too Many Requests', retryable: false }]),
    );
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.reason).toBe('rate-limit');
      expect(out.sawVisibleOutput).toBe(false);
    }
  });

  it('classifies a thrown exception (auth)', async () => {
    const out = await attempt(scriptedProvider({ throw: 'API Error: 401 Unauthorized' }));
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.reason).toBe('auth-expired');
      expect(out.err).toBeInstanceOf(Error);
    }
  });

  it('does NOT latch failure when a result recovers after a transient error event', async () => {
    const out = await attempt(
      scriptedProvider([
        { type: 'error', message: 'API retry', retryable: true },
        { type: 'result', text: null },
      ]),
    );
    expect(out.kind).toBe('ok');
  });

  it('clears the failover reason if a result arrives after a non-retryable error', async () => {
    // Error then a real result → the SDK recovered; treat as success.
    const out = await attempt(
      scriptedProvider([
        { type: 'error', message: '503 overloaded', retryable: false },
        { type: 'result', text: null },
      ]),
    );
    expect(out.kind).toBe('ok');
  });

  it('treats a turn-timeout error event as non-failover (ok, no result)', async () => {
    // Timeout is out of scope — classifies to 'none', so the attempt is "ok".
    const out = await attempt(
      scriptedProvider([{ type: 'error', message: 'Turn timed out after 900000ms', retryable: false }]),
    );
    expect(out.kind).toBe('ok');
  });
});
