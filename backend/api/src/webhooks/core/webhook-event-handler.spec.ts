import { actorWith } from '../../../tests/fakes/actors.js';
import type { Actor } from '../../access/core/actor.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import type { WebhookEvent } from './webhook.js';
import {
  type OutgoingEvent,
  WebhookEventHandler,
  WebhookEventHandlers,
} from './webhook-event-handler.js';
import { WebhookEventBuilder } from './webhook-events.js';

/** A handler for `group` that makes `made` of any row (null: a bad payload) and covers whom `covers` says. */
class Handler extends WebhookEventHandler {
  readonly calls: string[] = [];
  constructor(
    readonly group: string,
    private readonly made: OutgoingEvent[] | null = [],
    private readonly covers: (actor: Actor) => boolean = () => true,
  ) {
    super();
  }
  async build(event: OutboxEvent): Promise<OutgoingEvent[] | undefined> {
    this.calls.push(event.topic);
    return this.made ?? undefined;
  }
  coversAnyOwner(actor: Actor): boolean {
    return this.covers(actor);
  }
}

const every = () => [
  new Handler('releases'),
  new Handler('change-sets'),
  new Handler('translations'),
];

const row = (topic: string): OutboxEvent => ({
  position: { tx: '1', id: 1 },
  topic,
  key: 'k',
  payload: {},
  createdAt: new Date(),
});

const event = (type: WebhookEvent): OutgoingEvent => ({
  type,
  idempotencyKey: type,
  data: {},
});

const reader = actorWith(['content.read']);

describe('WebhookEventHandlers', () => {
  it('takes one handler per registered group', () => {
    expect(() => new WebhookEventHandlers(every())).not.toThrow();
  });

  it('refuses a registered group without its handler, so the API does not start', () => {
    expect(
      () =>
        new WebhookEventHandlers([
          new Handler('releases'),
          new Handler('change-sets'),
        ]),
    ).toThrow(/No webhook event handler for translations/);
    expect(() => new WebhookEventHandlers([])).toThrow(
      /No webhook event handler for releases, change-sets, translations/,
    );
  });

  it('refuses two handlers for one group, and one for a group that registers no event', () => {
    expect(
      () => new WebhookEventHandlers([...every(), new Handler('releases')]),
    ).toThrow(/Two webhook event handlers for releases/);
    expect(
      () => new WebhookEventHandlers([...every(), new Handler('comments')]),
    ).toThrow(/for comments, which registers no webhook event/);
  });

  it('loads once, and answers nothing before', () => {
    const handlers = new WebhookEventHandlers();
    expect(() => handlers.ofTopic('release.published')).toThrow(
      /not been loaded/,
    );
    expect(() => handlers.coversAnyOwner(reader, [])).toThrow(
      /not been loaded/,
    );
    handlers.load(every());
    expect(() => handlers.load(every())).toThrow(/loaded already/);
  });

  it('reads a handler’s group once, as it loads', () => {
    const [releases, changeSets, translations] = every() as [
      Handler,
      Handler,
      Handler,
    ];
    const handlers = new WebhookEventHandlers([
      releases,
      changeSets,
      translations,
    ]);
    (releases as { group: string }).group = 'translations';
    expect(handlers.ofTopic('release.published')).toBe(releases);
    expect(handlers.ofTopic('translation.imported')).toBe(translations);
  });

  it('finds each topic’s handler by the group that registered it', () => {
    const [releases, changeSets, translations] = every();
    const handlers = new WebhookEventHandlers([
      translations!,
      releases!,
      changeSets!,
    ]);
    expect(handlers.ofTopic('release.published')).toBe(releases);
    expect(handlers.ofTopic('release.withdrawn')).toBe(releases);
    expect(handlers.ofTopic('module.deprecated')).toBe(changeSets);
    expect(handlers.ofTopic('manual.deprecated')).toBe(changeSets);
    expect(handlers.ofTopic('translation.imported')).toBe(translations);
    expect(handlers.ofTopic('comment.added')).toBeUndefined();
    expect(handlers.ofTopic('constructor')).toBeUndefined();
  });

  it('covers an owner only with content.read restricting nothing, and what each event’s handler adds', () => {
    const drafts = actorWith(['content.read', 'content.read.draft']);
    const handlers = new WebhookEventHandlers([
      new Handler('releases'),
      new Handler('change-sets'),
      new Handler('translations', [], (a) =>
        a.roles.some((r) => r.permissions.includes('content.read.draft')),
      ),
    ]);
    const scoped = actorWith(['content.read'], { maxAudience: 'public' });
    expect(handlers.coversAnyOwner(reader, [])).toBe(true);
    expect(handlers.coversAnyOwner(reader, ['manual.released'])).toBe(true);
    expect(handlers.coversAnyOwner(reader, ['translation.imported'])).toBe(
      false,
    );
    expect(handlers.coversAnyOwner(drafts, ['translation.imported'])).toBe(
      true,
    );
    // A handler can only narrow: without content.read restricting nothing, nobody is covered.
    expect(handlers.coversAnyOwner(scoped, [])).toBe(false);
    expect(handlers.coversAnyOwner(scoped, ['manual.released'])).toBe(false);
    expect(
      handlers.coversAnyOwner(actorWith(['content.read.draft']), [
        'translation.imported',
      ]),
    ).toBe(false);
    // An event no handler makes: nobody.
    expect(
      handlers.coversAnyOwner(drafts, ['manual.flown' as WebhookEvent]),
    ).toBe(false);
  });

  it('lists what a reader sees: every subscriber, their own and those without what they do not cover, or their own', () => {
    const owner = { kind: 'user', id: 'me' } as const;
    const handlers = new WebhookEventHandlers([
      new Handler('releases'),
      new Handler('change-sets', [], () => false),
      new Handler('translations', [], () => false),
    ]);
    expect(handlers.visibleTo(reader, owner)).toEqual({
      owner,
      orWithout: [
        'module.deprecated',
        'manual.deprecated',
        'translation.imported',
      ],
    });
    expect(new WebhookEventHandlers(every()).visibleTo(reader, owner)).toBe(
      'all',
    );
    expect(
      handlers.visibleTo(
        actorWith(['content.read'], { maxAudience: 'public' }),
        owner,
      ),
    ).toEqual({ owner });
  });
});

describe('WebhookEventBuilder', () => {
  const wanted = new Set<WebhookEvent>(['manual.released', 'module.released']);

  it('asks the handler of the row’s group, and keeps only the events its topic makes', async () => {
    const releases = new Handler('releases', [
      event('manual.released'),
      // Another group's, or another topic's: never sent.
      event('translation.imported'),
      event('release.withdrawn'),
      event('module.released'),
    ]);
    const translations = new Handler('translations', [
      event('manual.released'),
    ]);
    const builder = new WebhookEventBuilder(
      new WebhookEventHandlers([
        releases,
        new Handler('change-sets'),
        translations,
      ]),
    );
    expect(
      (await builder.of(row('release.published'), reader, wanted))?.map(
        (e) => e.type,
      ),
    ).toEqual(['manual.released', 'module.released']);
    // Nor one the subscriber does not want.
    expect(
      (
        await builder.of(
          row('release.published'),
          reader,
          new Set<WebhookEvent>(['module.released']),
        )
      )?.map((e) => e.type),
    ).toEqual(['module.released']);
    expect(releases.calls).toEqual(['release.published', 'release.published']);
    expect(
      await builder.of(
        row('translation.imported'),
        reader,
        new Set<WebhookEvent>(['translation.imported']),
      ),
    ).toEqual([]);
    expect(translations.calls).toEqual(['translation.imported']);
  });

  it('asks no handler for a topic that makes nothing wanted, or for an owner who reads nothing', async () => {
    const handlers = every();
    const builder = new WebhookEventBuilder(new WebhookEventHandlers(handlers));
    expect(await builder.of(row('release.withdrawn'), reader, wanted)).toEqual(
      [],
    );
    expect(await builder.of(row('comment.added'), reader, wanted)).toEqual([]);
    expect(
      await builder.of(
        row('release.published'),
        actorWith(['webhook.manage']),
        wanted,
      ),
    ).toEqual([]);
    expect(handlers.flatMap((h) => h.calls)).toEqual([]);
  });

  it('passes on a payload that is not what its topic writes', async () => {
    const builder = new WebhookEventBuilder(
      new WebhookEventHandlers([
        new Handler('releases', null),
        new Handler('change-sets'),
        new Handler('translations'),
      ]),
    );
    expect(
      await builder.of(row('release.published'), reader, wanted),
    ).toBeUndefined();
  });
});
