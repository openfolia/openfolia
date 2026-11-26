import { printModule } from '@openfolia/content-model';
import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuthoredBranches } from '../../../../tests/fakes/fake-authored-branches.js';
import { FakeChangeSetBranches } from '../../../../tests/fakes/fake-change-set-branches.js';
import { FakeChangeSetStore } from '../../../../tests/fakes/fake-change-set-store.js';
import {
  config,
  FakeSnapshot,
  manifest,
  module,
} from '../../../../tests/fakes/fake-content.js';
import { FakeJobQueue } from '../../../../tests/fakes/fake-job-queue.js';
import {
  FakeMailSettings,
  FakeMailStore,
} from '../../../../tests/fakes/fake-mail.js';
import { FakeNotificationEmailQueue } from '../../../../tests/fakes/fake-notification-email-queue.js';
import { FakeNotificationStore } from '../../../../tests/fakes/fake-notification-store.js';
import { FakePreferenceStore } from '../../../../tests/fakes/fake-preference-store.js';
import { fakeSealer } from '../../../../tests/fakes/fake-secret-key.js';
import { MailOutbox } from '../../../mail/core/mail-outbox.js';
import { NotificationRouting } from '../notification-routing.js';
import { FakeOutboxFeed } from '../../../../tests/fakes/fake-outbox-feed.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { FakeUserDirectory } from '../../../../tests/fakes/fake-user-directory.js';
import type { Actor, Scope } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { API_TOKEN_ACTOR } from '../../../access/core/service-actor.js';
import { NotFoundError, UnavailableError } from '../../../base/core/errors.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../../../change-sets/core/change-set.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../../content/core/content.repository.js';
import { FanOut } from '../fan-out.js';
import {
  BATCH_SIZE,
  CONSUMER,
  DeliverNotificationsAction,
  MAX_ATTEMPTS,
} from './deliver-notifications.action.js';
import {
  CountUnreadNotificationsAction,
  GetNotificationAction,
  ListNotificationsAction,
} from './list-notifications.action.js';
import { MarkNotificationsReadAction } from './mark-notifications-read.action.js';
import { PruneNotificationsAction } from './prune-notifications.action.js';

const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (
  id: string,
  permissions: Permission[],
  scope: Scope = {},
): Actor => ({ ...actorWith([...READS, ...permissions], scope), id });

const author = user('sample-author', ['content.edit', 'content.review']);
const reviewer = user('sample-reviewer', ['content.review'], {
  languages: ['en'],
});
const germanReviewer = user('german-reviewer', ['content.review'], {
  languages: ['de'],
});
/** Reviews, but reads no drafts: hears of nothing to review. */
const blindReviewer: Actor = {
  ...actorWith(['content.read', 'content.review']),
  id: 'blind-reviewer',
};
const admin = user('sample-admin', ['admin.roles']);
const publisher = user('sample-publisher', ['release.publish']);
const reader: Actor = { ...actorWith(['content.read']), id: 'sample-reader' };

class Repository extends ContentRepository {
  readonly byRef = new Map<string, ContentSnapshot>();
  main!: ContentSnapshot;
  async at(ref: string) {
    return ref === 'main' ? this.main : this.byRef.get(ref);
  }
  async refs() {
    return { branches: [{ name: 'main', commit: this.main.commit }], tags: [] };
  }
}

/** A change set by `author` whose branch changes `charging` (en) in one commit. */
function setUp(
  people: readonly Actor[] = [
    author,
    reviewer,
    germanReviewer,
    blindReviewer,
    admin,
    publisher,
    reader,
  ],
) {
  const content = {
    config,
    modules: [module('charging')],
    manifests: [manifest('guide', ['charging'])],
  };
  const repository = new Repository();
  const main = new FakeSnapshot(content);
  repository.main = main;
  repository.byRef.set(main.commit, main);
  const head = new FakeSnapshot({
    ...content,
    modules: [module('charging', 'en', 'Changed.')],
  });
  repository.byRef.set(head.commit, head);
  const branches = new FakeChangeSetBranches();
  const id = newChangeSetId();
  branches.commits.set(head.commit, {
    branch: changeSetBranch(id),
    parent: main.commit,
    changes: [
      {
        path: 'modules/en/charging.adoc',
        content: printModule(module('charging', 'en', 'Changed.')),
      },
    ],
    message: 'Changed',
    author: { kind: 'user', id: author.id },
    changeSetId: id,
    tree: 'tree',
  });
  const now = new Date();
  const changeSet: ChangeSet = {
    id,
    title: 'Clearer charging',
    description: null,
    author: { kind: 'user', id: author.id },
    baseRef: 'main',
    baseCommit: main.commit,
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'in-review',
    reviewHead: head.commit,
    createdAt: now,
    updatedAt: now,
  };
  const changeSets = new FakeChangeSetStore([changeSet]);
  const open = new OpenSnapshotAction(repository, new FakeAuthoredBranches());
  const users = new FakeUserDirectory(people);
  const fanOut = new FanOut(changeSets, branches, open, users);
  const feed = new FakeOutboxFeed();
  const store = new FakeNotificationStore();
  const unit = new FakeUnitOfWork();
  const preferences = new FakePreferenceStore();
  return {
    changeSet,
    head: head.commit,
    main: main.commit,
    users,
    fanOut,
    feed,
    store,
    unit,
    preferences,
    deliver: new DeliverNotificationsAction(
      feed,
      fanOut,
      store,
      unit,
      new NotificationRouting(
        preferences,
        new FakeNotificationEmailQueue(store),
        new MailOutbox(
          new FakeMailSettings(),
          new FakeMailStore(),
          fakeSealer(1),
          new FakeJobQueue(),
        ),
      ),
    ),
    list: new ListNotificationsAction(store),
    get: new GetNotificationAction(store),
    unread: new CountUnreadNotificationsAction(store),
    mark: new MarkNotificationsReadAction(store, unit),
    prune: new PruneNotificationsAction(store),
  };
}

type Setup = ReturnType<typeof setUp>;

const transition = (
  s: Setup,
  name: string,
  actor: Actor,
  extra: Record<string, unknown> = {},
) =>
  s.feed.add(`change-set.${name}`, {
    changeSetId: s.changeSet.id,
    actor: { kind: actor.kind, id: actor.id },
    from: 'in-review',
    to: 'draft',
    ...extra,
  });

const recipients = (s: Setup) =>
  s.store.stored.map((n) => [n.kind, n.recipient]);

describe('the fan-out', () => {
  it('tells exactly the reviewers whose scope covers a submitted change set, never its author', async () => {
    const s = setUp();
    transition(s, 'submit', author, { to: 'in-review', head: s.head });
    const report = await s.deliver.handle();
    expect(report).toMatchObject({ events: 1, stored: 1, skipped: [] });
    // Not the German reviewer (outside their scope), not the one who reads
    // no drafts, not the author (who also reviews).
    expect(recipients(s)).toEqual([['change-set.submit', reviewer.id]]);
    expect(s.store.stored[0]).toMatchObject({
      subject: { type: 'change-set', id: s.changeSet.id },
      payload: {
        changeSetId: s.changeSet.id,
        title: 'Clearer charging',
        by: { kind: 'user', id: author.id },
        state: 'in-review',
      },
    });
  });

  it('tells nobody of a submit by someone else they caused themselves', async () => {
    const s = setUp();
    transition(s, 'submit', reviewer, { to: 'in-review', head: s.head });
    await s.deliver.handle();
    expect(recipients(s)).toEqual([]);
  });

  it('tells the author when a reviewer returns, approves, signs off or merges, never the one who did', async () => {
    const s = setUp();
    for (const name of ['return', 'approve', 'sign-off', 'merge']) {
      transition(s, name, reviewer);
    }
    // An author who abandons, or edits: nobody else needs to know.
    transition(s, 'abandon', author);
    s.feed.add('change-set.commit', { changeSetId: s.changeSet.id });
    // The author merging their own change set hears nothing of it.
    transition(s, 'merge', author);
    const report = await s.deliver.handle();
    expect(report).toMatchObject({ events: 7, skipped: [] });
    expect(recipients(s)).toEqual([
      ['change-set.return', author.id],
      ['change-set.approve', author.id],
      ['change-set.sign-off', author.id],
      ['change-set.merge', author.id],
    ]);
    expect(s.store.stored[0]?.payload).toEqual({
      changeSetId: s.changeSet.id,
      title: 'Clearer charging',
      by: { kind: 'user', id: reviewer.id },
      state: 'draft',
    });
  });

  it('tells a lock’s holder that an admin broke it', async () => {
    const s = setUp();
    s.feed.add('lock.break', {
      changeSetId: s.changeSet.id,
      actor: { kind: 'user', id: admin.id },
      holder: { kind: 'user', id: author.id },
      subjects: ['module/en/charging'],
      count: 1,
    });
    await s.deliver.handle();
    expect(s.store.stored).toMatchObject([
      {
        kind: 'lock.break',
        recipient: author.id,
        subject: { type: 'change-set', id: s.changeSet.id },
        payload: { count: 1, subjects: ['module/en/charging'] },
      },
    ]);
  });

  it('tells the importer of their import, and publishers of a failed output', async () => {
    const s = setUp();
    s.feed.add('translation.imported', {
      importId: 'imp-1',
      importer: { kind: 'user', id: author.id },
      actor: { kind: 'service', id: 'service:jobs' },
      changeSetId: s.changeSet.id,
    });
    s.feed.add('release.output-failed', {
      releaseId: 'rel-1',
      manualId: 'guide',
      commit: s.main,
    });
    await s.deliver.handle();
    expect(recipients(s)).toEqual([
      ['translation.imported', author.id],
      ['release.output-failed', publisher.id],
    ]);
    expect(s.store.stored[0]?.subject).toEqual({ type: 'import', id: 'imp-1' });
  });

  it('tells the publishers who heard of a failed output that it is ready after all (#551)', async () => {
    const s = setUp([author, reader, publisher]);
    for (const topic of ['release.output-failed', 'release.output-recovered']) {
      s.feed.add(topic, {
        releaseId: 'rel-1',
        outputId: 'out-1',
        manualId: 'guide',
        commit: s.main,
      });
    }
    await s.deliver.handle();
    expect(recipients(s)).toEqual([
      ['release.output-failed', publisher.id],
      ['release.output-recovered', publisher.id],
    ]);
    expect(s.store.stored[1]).toMatchObject({
      subject: { type: 'release', id: 'rel-1' },
      payload: { releaseId: 'rel-1', manualId: 'guide' },
    });
  });

  it('tells the publishers of an offline package’s level that it failed, judged by its audience, not a manual (#59)', async () => {
    const s = setUp([author, reader, publisher]);
    s.feed.add('release.output-failed', {
      releaseId: 'rel-1',
      outputId: 'out-1',
      manualId: '*',
      kind: 'offline-package',
      audience: 'public',
      commit: s.main,
    });
    await s.deliver.handle();
    expect(recipients(s)).toEqual([['release.output-failed', publisher.id]]);
    expect(s.store.stored[0]?.subject).toEqual({
      type: 'release',
      id: 'rel-1',
    });
  });

  it('tells the readers of a manual of a major release only', async () => {
    const s = setUp([author, reader]);
    for (const level of ['minor', 'major']) {
      s.feed.add('release.published', {
        releaseId: `rel-${level}`,
        manualIds: ['guide', 'missing'],
        commit: s.main,
        level,
        actor: { kind: 'user', id: 'sample-publisher' },
      });
    }
    await s.deliver.handle();
    expect(recipients(s).sort()).toEqual([
      ['release.published', author.id],
      ['release.published', reader.id],
    ]);
    // Only the manuals each one reads: one that is not there is named to nobody.
    expect(s.store.stored[0]?.payload).toEqual({
      releaseId: 'rel-major',
      level: 'major',
      manualIds: ['guide'],
    });
  });

  it('passes over a row whose payload is not what its topic writes', async () => {
    const s = setUp();
    s.feed.add('change-set.return', { changeSetId: 42 });
    transition(s, 'return', reviewer);
    const report = await s.deliver.handle();
    expect(report.skipped).toMatchObject([
      { topic: 'change-set.return', reason: 'payload' },
    ]);
    expect(recipients(s)).toEqual([['change-set.return', author.id]]);
  });

  it('tells those who were administrators at an emergency sign-in, whatever they are or set now (#378)', async () => {
    const other = user('other-admin', ['content.read']);
    const later = user('later-admin', ['admin.roles']);
    const s = setUp([author, admin, reader, other, later]);
    await s.preferences.write(other.id, { notifications: { allOff: true } });
    s.feed.add('sign-in.break-glass', {
      userId: admin.id,
      admins: [admin.id, other.id, 'gone'],
    });
    s.feed.add('sign-in.break-glass', { userId: 42 });
    const report = await s.deliver.handle();
    expect(report.skipped).toMatchObject([
      { topic: 'sign-in.break-glass', reason: 'payload' },
    ]);
    expect(recipients(s).sort()).toEqual([
      ['sign-in.break-glass', other.id],
      ['sign-in.break-glass', admin.id],
    ]);
    expect(s.store.stored[0]).toMatchObject({
      subject: { type: 'user', id: admin.id },
      payload: { by: { kind: 'user', id: admin.id } },
    });
  });

  it('tells every admin.backups holder of a failed or overdue backup, nobody else', async () => {
    const backups = user('sample-backups', ['admin.backups']);
    const s = setUp([author, admin, reader, backups]);
    s.feed.add('backup.failed', {
      runId: '10000000-0000-4000-8000-000000000001',
      error: 'verify-failed',
    });
    s.feed.add('backup.overdue', {
      lastGoodRunId: null,
      lastGoodAt: null,
      warnAfterHours: 26,
    });
    await s.deliver.handle();
    expect(recipients(s)).toEqual([
      ['backup.failed', backups.id],
      ['backup.overdue', backups.id],
    ]);
    expect(s.store.stored[0]).toMatchObject({
      subject: { type: 'backup', id: '10000000-0000-4000-8000-000000000001' },
      payload: { error: 'verify-failed' },
    });
    expect(s.store.stored[1]).toMatchObject({
      subject: { type: 'backup', id: 'instance' },
      payload: { lastGoodAt: null, warnAfterHours: 26 },
    });
  });
});

describe('delivering', () => {
  it('notifies once when the batch is read again (a restart mid-batch)', async () => {
    const s = setUp();
    transition(s, 'return', reviewer);
    // The process stops before the batch is recorded: nothing of it is kept.
    const failing = s.store.add.bind(s.store);
    s.store.add = () => Promise.reject(new Error('stopped'));
    await expect(s.deliver.handle()).rejects.toThrow('stopped');
    expect(s.store.stored).toEqual([]);
    expect(s.feed.cursors.get(CONSUMER)).toBeUndefined();
    s.store.add = failing;
    await s.deliver.handle();
    // Read again from the start (a cursor reset, two servers): still once.
    s.feed.cursors.delete(CONSUMER);
    const again = await s.deliver.handle();
    expect(again).toMatchObject({ events: 1, stored: 0 });
    expect(recipients(s)).toEqual([['change-set.return', author.id]]);
  });

  it('drops its batch when another server recorded it first', async () => {
    const s = setUp();
    const row = transition(s, 'return', reviewer);
    s.feed.beforeAdvance = () => s.feed.cursors.set(CONSUMER, row.position);
    const report = await s.deliver.handle();
    expect(report).toMatchObject({ raced: true, stored: 0 });
    expect(s.store.stored).toEqual([]);
  });

  it('delivers nothing while the outbox holds it after a restore, and everything once it goes on (#619)', async () => {
    const s = setUp();
    transition(s, 'return', reviewer);
    s.feed.held.add(CONSUMER);
    expect(await s.deliver.handle()).toMatchObject({
      blocked: true,
      events: 0,
      stored: 0,
    });
    expect(s.feed.cursors.get(CONSUMER)).toBeUndefined();
    s.feed.held.delete(CONSUMER);
    expect(await s.deliver.handle()).toMatchObject({
      blocked: false,
      events: 1,
      stored: 1,
    });
  });

  it('waits for a transaction still running, and keeps the rows after it', async () => {
    const s = setUp();
    s.feed.add(
      'change-set.return',
      {
        changeSetId: s.changeSet.id,
        actor: { kind: 'user', id: reviewer.id },
      },
      { pending: true },
    );
    transition(s, 'approve', reviewer);
    expect(await s.deliver.handle()).toMatchObject({ events: 0 });
    for (const row of s.feed.rows) delete row.pending;
    expect(await s.deliver.handle()).toMatchObject({ events: 2, stored: 2 });
  });

  it('reads batch after batch', async () => {
    const s = setUp();
    for (let i = 0; i < BATCH_SIZE + 5; i++) transition(s, 'return', reviewer);
    expect(await s.deliver.handle()).toMatchObject({
      events: BATCH_SIZE + 5,
      stored: BATCH_SIZE + 5,
    });
  });

  it('records the rows before one that fails, and tries it again', async () => {
    const s = setUp();
    transition(s, 'return', reviewer);
    transition(s, 'approve', reviewer);
    const real = s.fanOut.of.bind(s.fanOut);
    let failures = 0;
    s.fanOut.of = async (event, people) => {
      if (event.topic === 'change-set.approve' && failures++ < 1) {
        throw new Error('git broke');
      }
      return real(event, people);
    };
    const first = await s.deliver.handle();
    expect(first).toMatchObject({ events: 1, stored: 1 });
    expect(first.retry?.topic).toBe('change-set.approve');
    expect(await s.deliver.handle()).toMatchObject({ events: 1, stored: 1 });
    expect(recipients(s)).toEqual([
      ['change-set.return', author.id],
      ['change-set.approve', author.id],
    ]);
  });

  it(`passes over a row failing ${MAX_ATTEMPTS} times, or refused, but never one an outage stops`, async () => {
    const s = setUp();
    transition(s, 'return', reviewer);
    transition(s, 'approve', reviewer);
    transition(s, 'merge', reviewer);
    const real = s.fanOut.of.bind(s.fanOut);
    let down = true;
    s.fanOut.of = async (event, people) => {
      if (event.topic === 'change-set.return') throw new Error('always');
      if (event.topic === 'change-set.approve') {
        throw new NotFoundError('no such commit');
      }
      if (down) throw new UnavailableError('database-unavailable', 'down', 1);
      return real(event, people);
    };
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await s.deliver.handle()).toMatchObject({ events: 0 });
    }
    const passed = await s.deliver.handle();
    expect(passed.skipped).toMatchObject([
      { topic: 'change-set.return', reason: 'failing' },
      { topic: 'change-set.approve', reason: 'refused' },
    ]);
    // The outage: tried again however often.
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      expect(await s.deliver.handle()).toMatchObject({ events: 0 });
    }
    down = false;
    expect(await s.deliver.handle()).toMatchObject({ events: 1, stored: 1 });
    expect(recipients(s)).toEqual([['change-set.merge', author.id]]);
  });
});

describe('a person’s notifications', () => {
  async function delivered() {
    const s = setUp();
    transition(s, 'return', reviewer);
    transition(s, 'approve', reviewer);
    transition(s, 'submit', author, { to: 'in-review', head: s.head });
    await s.deliver.handle();
    return s;
  }

  it('lists only their own, newest first, with the unread count', async () => {
    const s = await delivered();
    const mine = await s.list.handle({
      actor: author,
      filter: {},
      page: { number: 1, size: 50 },
    });
    expect(mine.total).toBe(2);
    expect(mine.unreadCount).toBe(2);
    expect(mine.items.every((n) => n.recipient === author.id)).toBe(true);
    const theirs = await s.list.handle({
      actor: reviewer,
      filter: {},
      page: { number: 1, size: 50 },
    });
    expect(theirs.items.map((n) => n.kind)).toEqual(['change-set.submit']);
    // A service has none.
    expect(
      await s.list.handle({
        actor: API_TOKEN_ACTOR,
        filter: {},
        page: { number: 1, size: 50 },
      }),
    ).toEqual({ items: [], total: 0, unreadCount: 0 });
  });

  it('never reads or marks another person’s: not found, and nothing marked', async () => {
    const s = await delivered();
    const theirs = s.store.stored.find((n) => n.recipient === reviewer.id);
    const mine = s.store.stored.find((n) => n.recipient === author.id);
    if (!theirs || !mine) throw new Error('not delivered');
    await expect(
      s.get.handle({ actor: author, id: theirs.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.mark.handle({ actor: author, ids: [mine.id, theirs.id] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mine.readAt).toBeUndefined();
    expect(theirs.readAt).toBeUndefined();
    expect((await s.get.handle({ actor: author, id: mine.id })).id).toBe(
      mine.id,
    );
  });

  it('counts fewer unread once marked read, one or all', async () => {
    const s = await delivered();
    const [first] = (
      await s.list.handle({
        actor: author,
        filter: { unread: true },
        page: { number: 1, size: 50 },
      })
    ).items;
    if (!first) throw new Error('none');
    expect(await s.unread.handle({ actor: author })).toMatchObject({
      count: 2,
    });
    expect(await s.mark.handle({ actor: author, ids: [first.id] })).toEqual({
      marked: 1,
      unreadCount: 1,
    });
    // Marking it again marks nothing.
    expect(await s.mark.handle({ actor: author, ids: [first.id] })).toEqual({
      marked: 0,
      unreadCount: 1,
    });
    expect(await s.mark.handle({ actor: author, ids: 'all' })).toEqual({
      marked: 1,
      unreadCount: 0,
    });
    // Another person's stay unread.
    expect(await s.unread.handle({ actor: reviewer })).toMatchObject({
      count: 1,
    });
  });

  it('deletes read notifications past the retention, never unread ones', async () => {
    const s = await delivered();
    await s.mark.handle({ actor: author, ids: 'all' });
    const later = Date.now() + 91 * 24 * 60 * 60 * 1_000;
    expect(await s.prune.handle({ keepDays: 90, now: Date.now() })).toBe(0);
    expect(await s.prune.handle({ keepDays: 90, now: later })).toBe(2);
    expect(recipients(s)).toEqual([['change-set.submit', reviewer.id]]);
  });
});
