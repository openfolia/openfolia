import { createHash } from 'node:crypto';
import type { Actor } from '../src/access/core/actor.js';
import { AesSecretSealer } from '../src/base/repos/aes-secret-sealer.js';
import { ReadChangesAction } from '../src/changes/core/actions/read-changes.action.js';
import { CursorExpiredError } from '../src/changes/core/change-cursor.js';
import { readerScopes, scopeDigest } from '../src/changes/core/feed-scopes.js';
import type { OutboxEvent } from '../src/outbox/core/outbox-feed.js';
import type { WebhookEventBuilder } from '../src/webhooks/core/webhook-events.js';
import { actorWith } from './fakes/actors.js';
import {
  FakeChangeFeedSource,
  FakeChunkStates,
  FakeFeedScopes,
} from './fakes/fake-change-feed.js';

/** The change feed's cursor under the real sealer (AES-256-GCM): its size, and a key rotation. */

const builder = {
  of: async (event: OutboxEvent) => [
    {
      type: 'manual.released',
      idempotencyKey: createHash('sha256').update(event.key).digest('hex'),
      data: {},
    },
  ],
} as unknown as WebhookEventBuilder;

const reader = (scope = {}): Actor => ({
  ...actorWith(['content.read'], scope),
  id: 'consumer',
});

function setup() {
  const source = new FakeChangeFeedSource();
  const scopes = new FakeFeedScopes();
  const states = new FakeChunkStates();
  const feed = (byte: number) =>
    new ReadChangesAction(
      source,
      scopes,
      states,
      builder,
      new AesSecretSealer(Buffer.alloc(32, byte)),
    );
  return { source, scopes, states, feed };
}

describe('the change feed’s cursor', () => {
  it('stays under 2 KiB with the longest IDs and in the middle of a scope change, however many scopes', async () => {
    const { source, scopes, states, feed } = setup();
    const long = (lang: string, i: number) =>
      `${lang}-Latn-ABCDEFGH-12345678/${'m'.repeat(95)}-${i}/${'b'.repeat(64)}`;
    const release = '0190f4e2-7c1a-7b3e-9a4d-2f6c8e1b5a3d';
    states.releases.set(
      release,
      [0, 1, 2].flatMap((i) => [
        { id: long('de', i), version: '1' },
        { id: long('en', i), version: '1' },
      ]),
    );
    source.add('release.published', { releaseId: release });
    const wide: Actor = {
      ...reader(),
      roles: [
        ...reader().roles,
        ...Array.from({ length: 50 }, (_, i) => ({
          id: `role-${i}`,
          name: 'Many',
          permissions: ['content.read' as const],
          scope: { facets: { product: [`product-${i}`, `other-${i}`] } },
        })),
      ],
    };
    const action = feed(1);
    const one = await action.handle({ actor: wide, size: 2 });
    // The scope changes in the middle of the snapshot: the cursor holds both.
    const two = await action.handle({
      actor: reader({ languages: ['de'] }),
      cursor: one.cursor,
      size: 1,
    });
    expect(two.events).toHaveLength(1);
    for (const cursor of [one.cursor, two.cursor]) {
      expect(cursor.length).toBeLessThan(2_048);
      expect(cursor).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
    // The scopes are kept beside it, by digest.
    expect(scopes.kept.get(scopeDigest(readerScopes(wide)))).toHaveLength(51);
  });

  it('is cursor-expired once the instance key was rotated', async () => {
    const { source, states, feed } = setup();
    states.releases.set('r1', [{ id: 'en/a', version: '1' }]);
    source.add('release.published', { releaseId: 'r1' });
    const { cursor } = await feed(1).handle({ actor: reader(), size: 10 });
    await expect(
      feed(1).handle({ actor: reader(), cursor, size: 10 }),
    ).resolves.toMatchObject({ upToDate: true });
    await expect(
      feed(2).handle({ actor: reader(), cursor, size: 10 }),
    ).rejects.toBeInstanceOf(CursorExpiredError);
  });
});
