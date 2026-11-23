import { actorWith } from '../../../tests/fakes/actors.js';
import type { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import type { ReleaseChangeReader } from '../../releases/core/actions/release-changes.action.js';
import type { ReleaseStore } from '../../releases/core/release-store.js';
import type { WebhookEvent } from './webhook.js';
import { WebhookEventBuilder } from './webhook-events.js';

const commit = 'c'.repeat(40);

/** A commit with a public module `old` and an internal one `secret`, in English and German. */
const openSnapshot = {
  handle: async () => ({
    commit,
    config: async () => ({
      audiences: [{ id: 'public' }, { id: 'internal' }],
      facets: [],
      languages: { source: 'en', targets: ['de'] },
    }),
    moduleMetaForCheck: async (id: string, lang: string) =>
      id === 'old' || id === 'secret' || id === 'public-new'
        ? {
            lang,
            type: 'procedure',
            audience: id === 'secret' ? 'internal' : 'public',
            facets: {},
          }
        : undefined,
    manifestForCheck: async (id: string) =>
      id === 'guide' || id === 'new-guide'
        ? { audience: 'public', hidesEntries: false }
        : id === 'internal-guide'
          ? { audience: 'internal', hidesEntries: false }
          : id === 'broken'
            ? 'unreadable'
            : undefined,
  }),
} as unknown as OpenSnapshotAction;

const builder = new WebhookEventBuilder(
  {} as ReleaseStore,
  {} as ReleaseChangeReader,
  openSnapshot,
);

const deprecated = (replacedBy: string | null): OutboxEvent => ({
  position: { tx: '1', id: 1 },
  topic: 'module.deprecated',
  key: 'k',
  payload: {
    moduleId: 'old',
    lang: 'en',
    commit,
    reason: 'Superseded',
    replacedBy,
  },
  createdAt: new Date(),
});

const wanted = new Set<WebhookEvent>(['module.deprecated']);
const everyone = actorWith(['content.read']);
const publicOnly = actorWith(['content.read'], { maxAudience: 'public' });

describe('WebhookEventBuilder, module.deprecated', () => {
  it('names the replacement to an owner who may read it', async () => {
    const [event] =
      (await builder.of(deprecated('secret'), everyone, wanted)) ?? [];
    expect(event?.data).toMatchObject({
      moduleId: 'old',
      replacedBy: 'secret',
    });
  });

  it('names no replacement the owner may not read, nor one cut by the audience limit', async () => {
    const [scoped] =
      (await builder.of(deprecated('secret'), publicOnly, wanted)) ?? [];
    expect(scoped?.data).toMatchObject({ moduleId: 'old', replacedBy: null });
    const [capped] =
      (await builder.of(deprecated('secret'), everyone, wanted, 'public')) ??
      [];
    expect(capped?.data).toMatchObject({ replacedBy: null });
    const [missing] =
      (await builder.of(deprecated('gone'), everyone, wanted)) ?? [];
    expect(missing?.data).toMatchObject({ replacedBy: null });
    const [readable] =
      (await builder.of(deprecated('public-new'), publicOnly, wanted)) ?? [];
    expect(readable?.data).toMatchObject({ replacedBy: 'public-new' });
  });

  it('tells nothing of a deprecated module the owner may not read', async () => {
    const event = {
      ...deprecated(null),
      payload: { moduleId: 'secret', commit },
    };
    expect(await builder.of(event, publicOnly, wanted)).toEqual([]);
  });
});

describe('WebhookEventBuilder, manual.deprecated (#558)', () => {
  const manual = (
    manualId: string,
    replacedBy: string | null = null,
  ): OutboxEvent => ({
    position: { tx: '1', id: 2 },
    topic: 'manual.deprecated',
    key: 'k2',
    payload: {
      manualId,
      reason: 'Merged into another',
      replacedBy,
      changeSetId: 'cs',
      commit,
    },
    createdAt: new Date(),
  });
  const manuals = new Set<WebhookEvent>(['manual.deprecated']);

  it('tells an owner who may read the manual, with a key over the manual and the commit', async () => {
    const [event] =
      (await builder.of(manual('guide', 'new-guide'), publicOnly, manuals)) ??
      [];
    expect(event).toMatchObject({
      type: 'manual.deprecated',
      data: {
        manualId: 'guide',
        commit,
        reason: 'Merged into another',
        replacedBy: 'new-guide',
      },
    });
    const [again] =
      (await builder.of(manual('guide'), everyone, manuals)) ?? [];
    expect(again?.idempotencyKey).toBe(event?.idempotencyKey);
    // Not subscribed to: nothing.
    expect(await builder.of(manual('guide'), everyone, wanted)).toEqual([]);
  });

  it('names no replacement the owner may not read, nor one cut by the audience limit', async () => {
    const [scoped] =
      (await builder.of(
        manual('guide', 'internal-guide'),
        publicOnly,
        manuals,
      )) ?? [];
    expect(scoped?.data).toMatchObject({ replacedBy: null });
    const [capped] =
      (await builder.of(
        manual('guide', 'internal-guide'),
        everyone,
        manuals,
        'public',
      )) ?? [];
    expect(capped?.data).toMatchObject({ replacedBy: null });
    const [missing] =
      (await builder.of(manual('guide', 'nowhere'), everyone, manuals)) ?? [];
    expect(missing?.data).toMatchObject({ replacedBy: null });
    const [readable] =
      (await builder.of(
        manual('guide', 'internal-guide'),
        everyone,
        manuals,
      )) ?? [];
    expect(readable?.data).toMatchObject({ replacedBy: 'internal-guide' });
  });

  it('tells nothing of a manual the owner may not read, a broken one only to who reads every level, and none of one not there', async () => {
    expect(
      await builder.of(manual('internal-guide'), publicOnly, manuals),
    ).toEqual([]);
    expect(
      await builder.of(manual('internal-guide'), everyone, manuals, 'public'),
    ).toEqual([]);
    expect(await builder.of(manual('broken'), publicOnly, manuals)).toEqual([]);
    expect(await builder.of(manual('broken'), everyone, manuals)).toHaveLength(
      1,
    );
    expect(await builder.of(manual('nowhere'), everyone, manuals)).toEqual([]);
    expect(
      await builder.of(
        { ...manual('guide'), payload: { manualId: 'guide' } },
        everyone,
        manuals,
      ),
    ).toBeUndefined();
  });
});
