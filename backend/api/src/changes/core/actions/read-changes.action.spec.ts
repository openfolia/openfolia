import { createHash } from 'node:crypto';
import { actorWith } from '../../../../tests/fakes/actors.js';
import {
  FakeSecretCipher,
  testKey,
} from '../../../../tests/fakes/fake-secret-key.js';
import {
  FakeChangeFeedSource,
  FakeChunkStates,
  FakeFeedScopes,
} from '../../../../tests/fakes/fake-change-feed.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import {
  NotConfiguredError,
  UnavailableError,
} from '../../../base/core/errors.js';
import { SecretSealer } from '../../../base/core/secret-sealer.js';
import type { OutboxEvent } from '../../../outbox/core/outbox-feed.js';
import type { WebhookEventBuilder } from '../../../webhooks/core/webhook-events.js';
import {
  CHUNK_FORMAT,
  CursorExpiredError,
  CursorGoneError,
  sealCursor,
} from '../change-cursor.js';
import { readerScopes, scopeDigest } from '../feed-scopes.js';
import {
  type FeedEvent,
  ReadChangesAction,
  DEPRECATIONS_PER_PAGE,
  ROWS_PER_PAGE,
  TRANSITIONS_PER_PAGE,
} from './read-changes.action.js';

const reader = (id: string, scope: Scope = {}): Actor => ({
  ...actorWith(['content.read'], scope),
  id,
});
const full = reader('consumer');
const english = reader('consumer', { languages: ['en'] });
const german = reader('consumer', { languages: ['de'] });

/** A sealer under the test key `byte` (one key, one sealer: a rotation is another byte). */
const sealerOf = (byte: number) => new FakeSecretCipher().sealer(testKey(byte));

/** One webhook event per row, told only to a reader of every language. */
const builder = {
  of: async (event: OutboxEvent, owner: Actor) => {
    if (!owner.roles.some((r) => !r.scope.languages)) return [];
    const type =
      event.topic === 'release.published'
        ? 'manual.released'
        : event.topic === 'release.withdrawn'
          ? 'release.withdrawn'
          : event.topic === 'manual.deprecated'
            ? 'manual.deprecated'
            : 'module.deprecated';
    return [
      {
        type,
        idempotencyKey: createHash('sha256').update(event.key).digest('hex'),
        data: { ...event.payload },
      },
    ];
  },
} as unknown as WebhookEventBuilder;

function setup(sealer: SecretSealer = sealerOf(1)) {
  const source = new FakeChangeFeedSource();
  const scopes = new FakeFeedScopes();
  const states = new FakeChunkStates();
  const action = new ReadChangesAction(source, scopes, states, builder, sealer);
  const publish = (id: string, chunks: [string, string][]) => {
    states.releases.set(
      id,
      chunks.map(([chunkId, version]) => ({ id: chunkId, version })),
    );
    return source.add('release.published', { releaseId: id });
  };
  const read = (actor: Actor, cursor?: string, size = 100) =>
    action.handle({ actor, cursor, size });
  /** Every event from `cursor`, `size` at a time, until up to date. */
  const drain = async (
    actor: Actor,
    cursor: string | undefined,
    size: number,
    between?: (page: number) => void,
  ) => {
    const events: FeedEvent[] = [];
    let at = cursor;
    for (let i = 0; i < 1_000; i++) {
      const page = await read(actor, at, size);
      events.push(...page.events);
      at = page.cursor;
      between?.(i);
      if (page.upToDate) return { events, cursor: at };
    }
    throw new Error('never caught up');
  };
  return { source, scopes, states, action, publish, read, drain };
}

const told = (events: readonly FeedEvent[]) =>
  events.map((e) =>
    e.type.startsWith('chunk.')
      ? `${e.type} ${String(e.data['chunkId'])}${e.data['reason'] ? ` ${String(e.data['reason'])}` : ''}`
      : e.type,
  );

describe('ReadChangesAction', () => {
  it('is off without the instance secret key, and needs content.read', async () => {
    const off = new (class extends SecretSealer {
      readonly available = false;
      seal(): string {
        throw new Error('no key');
      }
      open(): string {
        throw new Error('no key');
      }
    })();
    const { read } = setup(off);
    await expect(read(full)).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(setup().read(actorWith([]))).rejects.toThrow(/content\.read/);
  });

  it('answers 503 outbox-blocked while the outbox holds the feed after a restore, and cursor-gone for a cursor from before the recipe (#619)', async () => {
    const { source, publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const before = await drain(full, undefined, 100);
    source.held = true;
    for (const cursor of [undefined, before.cursor]) {
      await expect(read(full, cursor)).rejects.toMatchObject({
        constructor: UnavailableError,
        code: 'outbox-blocked',
        retryAfterSeconds: 60,
      });
    }
    // The recipe renumbers every row to transaction 1 and clears the latch.
    for (const row of source.rows) {
      (row as { position: OutboxEvent['position'] }).position = {
        tx: '1',
        id: row.position.id,
      };
    }
    source.held = false;
    await expect(read(full, before.cursor)).rejects.toBeInstanceOf(
      CursorGoneError,
    );
    // A fresh start reads on.
    const fresh = await drain(full, undefined, 100);
    publish('r2', [['en/a', '2']]);
    expect(told((await drain(full, fresh.cursor, 100)).events)).toContain(
      'chunk.upserted en/a',
    );
  });

  it('starts a fresh reader with the snapshot of the release standing, then tells what follows', async () => {
    const { publish, drain } = setup();
    publish('r1', [
      ['de/a', '1'],
      ['en/a', '1'],
    ]);
    const first = await drain(full, undefined, 100);
    expect(told(first.events)).toEqual([
      'chunk.upserted de/a',
      'chunk.upserted en/a',
    ]);
    publish('r2', [
      ['de/a', '1'],
      ['en/a', '2'],
      ['en/b', '1'],
    ]);
    const next = await drain(full, first.cursor, 100);
    expect(told(next.events)).toEqual([
      'manual.released',
      'chunk.upserted en/a',
      'chunk.upserted en/b',
    ]);
    expect(next.events[1]?.data).toMatchObject({
      contentHash: 'hash-2',
      release: { releaseId: 'r2', tag: 'release/north/r2' },
    });
  });

  it('skips and repeats nothing across pages while rows are written, and waits for a transaction still running', async () => {
    const { source, publish, read, drain } = setup();
    const start = (await read(full)).cursor;
    publish('r1', [
      ['de/a', '1'],
      ['en/a', '1'],
      ['en/b', '1'],
    ]);
    // A transaction still running: it and the rows after it wait.
    const running = source.add(
      'module.deprecated',
      { moduleId: 'a' },
      { pending: true },
    );
    let n = 2;
    const paged = await drain(full, start, 1, (page) => {
      if (page === 1) {
        publish(`r${n}`, [['en/a', String(n++)]]);
      }
    });
    expect(told(paged.events)).toEqual([
      'manual.released',
      'chunk.upserted de/a',
      'chunk.upserted en/a',
      'chunk.upserted en/b',
    ]);
    delete running.pending;
    const rest = await drain(full, paged.cursor, 1);
    expect(told(rest.events)).toEqual([
      'module.deprecated',
      'manual.released',
      'chunk.removed de/a gone',
      'chunk.upserted en/a',
      'chunk.removed en/b gone',
    ]);
    // The same in one go from the start.
    const whole = await drain(full, start, 100);
    expect(whole.events.map((e) => e.idempotencyKey)).toEqual(
      [...paged.events, ...rest.events].map((e) => e.idempotencyKey),
    );
  });

  it('moves no chunk state for a maintenance line’s release, and steps back on a withdrawal', async () => {
    const { source, publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    source.lineReleases.add('line-1');
    publish('line-1', [['en/old', '1']]);
    publish('r2', [
      ['en/a', '1'],
      ['en/b', '1'],
    ]);
    source.add('release.withdrawn', { releaseId: 'r2' });
    const { events } = await drain(full, start, 100);
    expect(told(events)).toEqual([
      'manual.released',
      'manual.released',
      'chunk.upserted en/b',
      'release.withdrawn',
      'chunk.removed en/b withdrawn',
    ]);
    expect((await read(full, start)).upToDate).toBe(true);
  });

  it('tells a deprecated module as removed', async () => {
    const { states, publish, source, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    states.releases.set('r2', [{ id: 'en/a', version: '1', deprecated: true }]);
    source.add('release.published', { releaseId: 'r2' });
    expect(told((await drain(full, start, 100)).events)).toEqual([
      'manual.released',
      'chunk.removed en/a deprecated',
    ]);
  });

  it('tells a reader whose scope narrowed what left it, and what they may read again once widened', async () => {
    const { publish, drain } = setup();
    publish('r1', [
      ['de/a', '1'],
      ['en/a', '1'],
    ]);
    const start = (await drain(full, undefined, 100)).cursor;
    const narrowed = await drain(english, start, 100);
    expect(told(narrowed.events)).toEqual(['chunk.removed de/a gone']);
    expect(narrowed.events[0]?.data['release']).toMatchObject({
      releaseId: 'r1',
    });
    const widened = await drain(full, narrowed.cursor, 100);
    expect(told(widened.events)).toEqual(['chunk.upserted de/a']);
  });

  it('starts a transition again when the scope changes in the middle of it, naming only what the reader held or may read', async () => {
    const { publish, read, drain } = setup();
    publish('r1', [
      ['de/a', '1'],
      ['en/a', '1'],
    ]);
    const start = (await drain(full, undefined, 100)).cursor;
    publish('r2', [
      ['de/a', '2'],
      ['de/b', '1'],
      ['en/a', '2'],
      ['en/c', '1'],
    ]);
    // Part of r2 told to the full scope…
    const part = await read(full, start, 2);
    expect(told(part.events)).toEqual([
      'manual.released',
      'chunk.upserted de/a',
    ]);
    // …then the reader is narrowed to English.
    const rest = await drain(english, part.cursor, 100);
    expect(told(rest.events)).toEqual([
      // de/a: they may hold r1's or r2's version; it is no longer theirs.
      'chunk.removed de/a gone',
      'chunk.upserted en/a',
      'chunk.upserted en/c',
    ]);
    // de/b was never told, so it is never named.
    expect(JSON.stringify(rest.events)).not.toContain('de/b');
  });

  it('expires a cursor whose transition the scope changed twice in the middle of', async () => {
    const { publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    publish('r2', [
      ['de/a', '1'],
      ['de/b', '1'],
      ['en/a', '2'],
      ['en/b', '1'],
    ]);
    const one = await read(full, start, 2);
    const two = await read(german, one.cursor, 1);
    // de/a was told already, in the version German readers see too.
    expect(told(two.events)).toEqual(['chunk.upserted de/b']);
    await expect(read(english, two.cursor, 1)).rejects.toBeInstanceOf(
      CursorExpiredError,
    );
  });

  it('refuses a cursor sealed under another key (a rotation), for another reader, or changed: cursor-expired', async () => {
    const { publish, scopes, states, source, drain } = setup(sealerOf(1));
    publish('r1', [['en/a', '1']]);
    const { cursor } = await drain(full, undefined, 100);
    const rotated = new ReadChangesAction(
      source,
      scopes,
      states,
      builder,
      sealerOf(2),
    );
    const expired = rotated.handle({ actor: full, cursor, size: 10 });
    await expect(expired).rejects.toBeInstanceOf(CursorExpiredError);
    await expect(expired).rejects.toMatchObject({
      code: 'cursor-expired',
      parameter: 'page[cursor]',
    });
    const action = new ReadChangesAction(
      source,
      scopes,
      states,
      builder,
      sealerOf(1),
    );
    await expect(
      action.handle({ actor: reader('someone-else'), cursor, size: 10 }),
    ).rejects.toBeInstanceOf(CursorExpiredError);
    await expect(
      action.handle({ actor: full, cursor: `${cursor}x`, size: 10 }),
    ).rejects.toBeInstanceOf(CursorExpiredError);
    // Sealed by us for them, but naming scopes not kept.
    const forged = sealCursor(sealerOf(1), full, {
      v: 1,
      cf: CHUNK_FORMAT,
      l: '0123456789abcdef',
      n: 0,
      at: ['0', 0],
      s: { r: 'r1', d: 'f'.repeat(64) },
    });
    await expect(
      action.handle({ actor: full, cursor: forged, size: 10 }),
    ).rejects.toBeInstanceOf(CursorExpiredError);
  });

  it('looks at a bounded number of rows per page', async () => {
    const { source, read } = setup();
    const start = (await read(full)).cursor;
    // Rows that tell this reader nothing.
    for (
      let i = 0;
      i < Math.min(ROWS_PER_PAGE, DEPRECATIONS_PER_PAGE) + 5;
      i++
    ) {
      source.add('module.deprecated', { moduleId: `m${i}` });
    }
    const page = await read(english, start, 1_000);
    expect(page.events).toEqual([]);
    expect(page.upToDate).toBe(false);
    const next = await read(english, page.cursor, 1_000);
    expect(next.upToDate).toBe(true);
  });

  it('starts a bounded number of releases per page', async () => {
    const { publish, read, drain } = setup();
    const start = (await read(full)).cursor;
    for (let i = 0; i < TRANSITIONS_PER_PAGE + 2; i++) {
      publish(`r${i}`, [['en/a', String(i)]]);
    }
    const page = await read(full, start, 1_000);
    expect(
      told(page.events).filter((e) => e.startsWith('chunk.')),
    ).toHaveLength(TRANSITIONS_PER_PAGE);
    expect(page.upToDate).toBe(false);
    const rest = await drain(full, page.cursor, 1_000);
    expect(told(rest.events)).toEqual([
      'manual.released',
      'chunk.upserted en/a',
      'manual.released',
      'chunk.upserted en/a',
    ]);
  });

  it('reads one page at a time per reader', async () => {
    const { action, publish } = setup();
    publish('r1', [['en/a', '1']]);
    const first = action.handle({ actor: full, size: 10 });
    await expect(
      action.handle({ actor: full, size: 10 }),
    ).rejects.toMatchObject({ code: 'rate-limited' });
    await first;
    await expect(
      action.handle({ actor: full, size: 10 }),
    ).resolves.toBeDefined();
  });

  it('never gives two events one key, not even a scope changed back and forth at one release', async () => {
    const { publish, drain } = setup();
    publish('r1', [
      ['de/a', '1'],
      ['en/a', '1'],
    ]);
    const keys: string[] = [];
    let at = (await drain(full, undefined, 100)).cursor;
    for (const actor of [english, full, english, full]) {
      const page = await drain(actor, at, 100);
      expect(page.events).toHaveLength(1);
      keys.push(...page.events.map((e) => e.idempotencyKey));
      at = page.cursor;
    }
    expect(new Set(keys).size).toBe(4);
    // Two fresh starts are two lineages: their snapshots share no key.
    const one = await drain(full, undefined, 100);
    const two = await drain(full, undefined, 100);
    expect(one.events[0]?.idempotencyKey).not.toBe(
      two.events[0]?.idempotencyKey,
    );
  });

  it('skips a release whose content cannot be read, and compares the next with the one before', async () => {
    const { states, publish, drain } = setup();
    publish('r1', [
      ['en/a', '1'],
      ['en/b', '1'],
    ]);
    const start = (await drain(full, undefined, 100)).cursor;
    states.unreadable.add('r2');
    publish('r2', [['en/a', '2']]);
    publish('r3', [['en/a', '1']]);
    expect(told((await drain(full, start, 100)).events)).toEqual([
      'manual.released',
      'manual.released',
      'chunk.removed en/b gone',
    ]);
  });

  it('removes every chunk held on a withdrawal back to a release that cannot be read', async () => {
    const { states, source, publish, drain } = setup();
    states.unreadable.add('r1');
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    publish('r2', [
      ['en/a', '2'],
      ['en/b', '1'],
    ]);
    source.add('release.withdrawn', { releaseId: 'r2' });
    expect(told((await drain(full, start, 100)).events)).toEqual([
      'manual.released',
      'chunk.upserted en/a',
      'chunk.upserted en/b',
      'release.withdrawn',
      'chunk.removed en/a withdrawn',
      'chunk.removed en/b withdrawn',
    ]);
  });

  it('goes on past a scope change at a state that cannot be read', async () => {
    const { states, source, publish, drain } = setup();
    states.unreadable.add('r1');
    publish('r1', [['en/a', '1']]);
    publish('r2', [
      ['en/a', '2'],
      ['de/a', '1'],
    ]);
    const start = (await drain(full, undefined, 100)).cursor;
    source.add('release.withdrawn', { releaseId: 'r2' });
    const withdrawn = await drain(full, start, 100);
    expect(told(withdrawn.events)).toEqual([
      'release.withdrawn',
      'chunk.removed de/a withdrawn',
      'chunk.removed en/a withdrawn',
    ]);
    // The reader now stands at r1, which cannot be read, and their scope narrows.
    const changed = await drain(english, withdrawn.cursor, 100);
    expect(changed.events).toEqual([]);
    publish('r3', [['en/a', '3']]);
    // A scoped reader gets no release events from the fake builder.
    expect(told((await drain(english, changed.cursor, 100)).events)).toEqual([
      'chunk.upserted en/a',
    ]);
  });

  it('removes what a reader held, the release told so far included, once its target becomes unreadable for them mid-feed (#558)', async () => {
    const { states, publish, read, drain } = setup();
    publish('r1', [
      ['de/a', '1'],
      ['en/a', '1'],
    ]);
    const start = (await drain(full, undefined, 100)).cursor;
    publish('r2', [
      ['de/0', '1'],
      ['de/a', '2'],
      ['de/b', '1'],
      ['en/a', '2'],
    ]);
    // Part of r2 told to the full scope, de/0 new in it…
    const part = await read(full, start, 3);
    expect(told(part.events)).toEqual([
      'manual.released',
      'chunk.upserted de/0',
      'chunk.upserted de/a',
    ]);
    // …then the reader is narrowed to a scope r2 cannot be read in.
    states.unreadableFor.add(`r2|${readerScopes(english).join(',')}`);
    const rest = await drain(english, part.cursor, 1);
    expect(told(rest.events)).toEqual([
      // What was told of r2, r1's chunks too: none may be kept.
      'chunk.removed de/0 gone',
      'chunk.removed de/a gone',
      'chunk.removed en/a gone',
    ]);
    // They hold nothing at r2 now, so the next release is told in full.
    publish('r3', [['en/a', '3']]);
    expect(told((await drain(english, rest.cursor, 100)).events)).toEqual([
      'chunk.upserted en/a',
    ]);
  });

  it('goes on removing after a scope change in the middle of a withdrawal to a state that cannot be read', async () => {
    const { states, source, publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    publish('r2', [
      ['de/a', '1'],
      ['en/a', '2'],
      ['en/b', '1'],
    ]);
    const atR2 = (await drain(full, start, 100)).cursor;
    states.unreadable.add('r1');
    source.add('release.withdrawn', { releaseId: 'r2' });
    const part = await read(full, atR2, 2);
    expect(told(part.events)).toEqual([
      'release.withdrawn',
      'chunk.removed de/a withdrawn',
    ]);
    // What was told of r1 was removals only: the restart holds nothing of it.
    const rest = await drain(english, part.cursor, 100);
    expect(told(rest.events)).toEqual([
      'chunk.removed de/a withdrawn',
      'chunk.removed en/a withdrawn',
      'chunk.removed en/b withdrawn',
    ]);
  });

  it('answers cursor-gone for a part-told release whose target no longer reads in the same scope', async () => {
    const { states, scopes, source, publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    publish('r2', [
      ['en/a', '2'],
      ['en/b', '1'],
    ]);
    const part = await read(full, start, 2);
    expect(told(part.events)).toEqual([
      'manual.released',
      'chunk.upserted en/a',
    ]);
    // After an upgrade (a new server, nothing kept), r2 no longer reads.
    states.unreadable.add('r2');
    const restarted = new ReadChangesAction(
      source,
      scopes,
      states,
      builder,
      sealerOf(1),
    );
    const gone = restarted.handle({
      actor: full,
      cursor: part.cursor,
      size: 10,
    });
    await expect(gone).rejects.toBeInstanceOf(CursorGoneError);
    await expect(gone).rejects.toMatchObject({
      code: 'cursor-gone',
      parameter: 'page[cursor]',
    });
  });

  it('answers cursor-gone for a part-told release even when another reader of the same scope cached its plan first', async () => {
    const { states, scopes, source, publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    const other = reader('other-consumer');
    const theirs = (await drain(other, undefined, 100)).cursor;
    publish('r2', [
      ['en/a', '2'],
      ['en/b', '1'],
    ]);
    const part = await read(full, start, 2);
    expect(told(part.events)).toEqual([
      'manual.released',
      'chunk.upserted en/a',
    ]);
    states.unreadable.add('r2');
    const restarted = new ReadChangesAction(
      source,
      scopes,
      states,
      builder,
      sealerOf(1),
    );
    // The other reader, with nothing of r2 told, skips it, and its plan is kept…
    const skipped = await restarted.handle({
      actor: other,
      cursor: theirs,
      size: 100,
    });
    expect(told(skipped.events)).toEqual(['manual.released']);
    // …which tells this reader nothing of what they were told of r2.
    await expect(
      restarted.handle({ actor: full, cursor: part.cursor, size: 100 }),
    ).rejects.toBeInstanceOf(CursorGoneError);
  });

  it('answers cursor-gone when the commit of what the reader holds is gone, and starts a fresh reader past it', async () => {
    const { states, publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    states.vanished.add('r1');
    publish('r2', [['en/b', '1']]);
    await expect(read(full, start)).rejects.toBeInstanceOf(CursorGoneError);
    // The documented resync: start again without a cursor.
    expect(told((await drain(full, undefined, 100)).events)).toEqual([
      'chunk.upserted en/b',
    ]);
  });

  it('skips a release whose chunks are too large to cut together, as one that cannot be read (#684)', async () => {
    const { states, publish, drain } = setup();
    publish('r1', [
      ['en/a', '1'],
      ['en/b', '1'],
    ]);
    const start = (await drain(full, undefined, 100)).cursor;
    states.tooLarge.add('r2');
    publish('r2', [['en/a', '2']]);
    publish('r3', [['en/a', '1']]);
    expect(told((await drain(full, start, 100)).events)).toEqual([
      'manual.released',
      'manual.released',
      'chunk.removed en/b gone',
    ]);
    // A fresh reader starting at it holds nothing there, and goes on from the next.
    const { states: s2, publish: p2, drain: d2 } = setup();
    p2('r1', [['en/a', '1']]);
    s2.tooLarge.add('r1');
    const fresh = await d2(full, undefined, 100);
    expect(fresh.events).toEqual([]);
    p2('r2', [['en/a', '2']]);
    expect(told((await d2(full, fresh.cursor, 100)).events)).toEqual([
      'manual.released',
      'chunk.upserted en/a',
    ]);
  });

  it('skips a release whose commit is gone, as one that cannot be read', async () => {
    const { states, publish, drain } = setup();
    publish('r1', [
      ['en/a', '1'],
      ['en/b', '1'],
    ]);
    const start = (await drain(full, undefined, 100)).cursor;
    states.vanished.add('r2');
    publish('r2', [['en/a', '2']]);
    publish('r3', [['en/a', '1']]);
    expect(told((await drain(full, start, 100)).events)).toEqual([
      'manual.released',
      'manual.released',
      'chunk.removed en/b gone',
    ]);
    // A fresh reader standing at a vanished release holds nothing there.
    const { states: s2, publish: p2, drain: d2 } = setup();
    p2('r1', [['en/a', '1']]);
    s2.vanished.add('r1');
    const fresh = await d2(full, undefined, 100);
    expect(fresh.events).toEqual([]);
    p2('r2', [['en/a', '2']]);
    expect(told((await d2(full, fresh.cursor, 100)).events)).toEqual([
      'manual.released',
      'chunk.upserted en/a',
    ]);
  });

  it('reads a cursor from before the "holds nothing" flag: on from a state that reads, cursor-gone at one that does not', async () => {
    const { states, scopes, source, publish } = setup();
    publish('r1', [['en/a', '1']]);
    const now = readerScopes(full);
    await scopes.save(scopeDigest(now), now);
    // As a server before #558 sealed it, standing at r1: no `x` anywhere.
    const old = sealCursor(sealerOf(1), full, {
      v: 1,
      cf: CHUNK_FORMAT,
      l: '0123456789abcdef',
      n: 1,
      at: [
        source.rows[0]?.position.tx ?? '0',
        source.rows[0]?.position.id ?? 0,
      ],
      s: { r: 'r1', d: scopeDigest(now) },
    });
    publish('r2', [
      ['en/a', '1'],
      ['en/b', '1'],
    ]);
    const server = () =>
      new ReadChangesAction(source, scopes, states, builder, sealerOf(1));
    const on = await server().handle({ actor: full, cursor: old, size: 100 });
    expect(told(on.events)).toEqual(['manual.released', 'chunk.upserted en/b']);
    // r1 no longer reads: what that cursor holds cannot be named.
    states.unreadable.add('r1');
    await expect(
      server().handle({ actor: full, cursor: old, size: 100 }),
    ).rejects.toBeInstanceOf(CursorGoneError);
  });

  it('tells a deprecated manual, as a deprecation row', async () => {
    const { source, publish, read, drain } = setup();
    publish('r1', [['en/a', '1']]);
    const start = (await drain(full, undefined, 100)).cursor;
    source.add('manual.deprecated', { manualId: 'guide' });
    const page = await read(full, start, 100);
    expect(told(page.events)).toEqual(['manual.deprecated']);
    expect(page.upToDate).toBe(true);
    expect(told((await read(english, start, 100)).events)).toEqual([]);
  });
});
