import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type Actor, UserId } from '../../access/core/actor.js';
import { allows, allowsManual, ANYWHERE } from '../../access/core/allows.js';
import type { Permission } from '../../access/core/permissions.js';
import { UserDirectory } from '../../access/core/user-directory.js';
import type { ChangeSet } from '../../change-sets/core/change-set.js';
import { ChangeSetBranches } from '../../change-sets/core/change-set-branches.js';
import { ChangeSetStore } from '../../change-sets/core/change-set-store.js';
import {
  coversChanges,
  reviewedChanges,
} from '../../change-sets/core/review-scope.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { OutboxEvent } from '../../outbox/core/outbox-feed.js';
import type {
  EventActor,
  NewNotification,
  NotificationKind,
  NotificationSubject,
} from './notification.js';

/**
 * Who the fan-out reads content as: a service that reads every ref, to
 * work out which people a change concerns. It never answers a request, and
 * nothing it reads goes into a notification but IDs, titles and states.
 */
export const NOTIFIER: Actor = Object.freeze({
  kind: 'service',
  // Outside the `UserId` format (":"), so no user can have this ID.
  id: 'service:notifications',
  roles: Object.freeze([
    Object.freeze({
      id: 'notifier',
      name: 'Notifications (read-only)',
      permissions: Object.freeze(['content.read', 'content.read.draft']),
      scope: Object.freeze({}),
    }),
  ]),
}) as Actor;

/** The most people one fan-out looks through (the user directory, by ID). */
export const MAX_PEOPLE = 10_000;
const PEOPLE_PAGE = 200;

/** The most locked subjects a lock-break notification names (its count says how many). */
export const MAX_NAMED_SUBJECTS = 20;

const Id = z.string().min(1).max(200);
const Who = z.object({ kind: z.enum(['user', 'service']), id: Id });
const Commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** What every `change-set.<transition>` outbox row holds (`recordTransition`). */
const Transition = z.object({
  changeSetId: Id,
  actor: Who,
  to: z.string().max(50).optional(),
  head: Commit.nullable().optional(),
  reason: z.string().max(100).optional(),
});

/** `lock.break` (`BreakLockAction`, `BreakLocksAction`): one row per change set. */
const LockBreak = z.object({
  changeSetId: Id,
  actor: Who,
  holder: Who,
  subjects: z.array(z.string().max(300)).max(1_000),
  count: z.number().int().min(1),
});

/**
 * `translation.imported`, `translation.import-failed` (#51): the import,
 * who started it, and the change set it committed into when it did. A
 * background import names its job as `actor`, so its importer hears of it.
 */
const Import = z.object({
  importId: Id,
  importer: Who,
  actor: Who,
  changeSetId: Id.optional(),
});

/** `release.published` (#138): the release, its manuals, its commit, its level. */
const ReleasePublished = z.object({
  releaseId: Id,
  // A release that changed no manual names none (#138).
  manualIds: z.array(Id).max(1_000),
  commit: Commit,
  level: z.enum(['major', 'minor', 'patch']),
  actor: Who,
});

/**
 * `release.output-failed` (#249) and `release.output-recovered` (#551):
 * the release and the manual whose output failed, or was told failed and
 * is done after all.
 */
const OutputFailed = z.object({
  releaseId: Id,
  manualId: Id,
  commit: Commit,
  actor: Who.optional(),
  /** `offline-package` (#59): of no one manual, judged by its audience level. */
  kind: z.string().optional(),
  audience: Id.nullable().optional(),
});

/** `backup.failed` (#529): the run that failed and why (a stable code). */
const BackupFailed = z.object({
  runId: Id,
  error: z.string().max(100),
});

/** `backup.overdue` (#529): the last good run, if any, and the limit passed. */
const BackupOverdue = z.object({
  lastGoodRunId: Id.nullable(),
  lastGoodAt: z.iso.datetime({ offset: true }).nullable(),
  warnAfterHours: z.number().int().min(1),
});

/** People, read once per pass and shared by the events of a batch. */
export type People = () => Promise<readonly Actor[]>;

/** A recipient and what their notification says. */
interface Addressed {
  readonly recipient: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * The fan-out (#252, defaults from #242): who hears of an outbox row.
 *
 * - `change-set.submit`: the holders of `content.review` whose scope
 *   covers everything the change set changes, at the head submitted, and
 *   who read all of it as a draft (`coversChanges` for both), so nobody
 *   hears of what they may not read.
 * - `change-set.return`, `approve`, `sign-off`, `merge`, `lock.break`: the
 *   change set's author (a lock's holder is its change set's author).
 * - `translation.imported`, `translation.import-failed`: the importer.
 * - `release.output-failed`: holders of `release.publish` over the manual.
 * - `release.output-recovered` (#551): the same people, once an output told
 *   failed is done after all (a late file, a retry, its group's file).
 * - `release.published`, a `major` release only: the readers of its
 *   manuals (`content.read` over each manual's audience); each hears only
 *   of the manuals they read.
 * - `backup.failed`, `backup.overdue` (#529): the holders of
 *   `admin.backups`, once per incident (the backup process keys the row).
 *
 * Never the actor who caused the event, and only people (users), never a
 * service. A row whose payload is not what its topic writes notifies
 * nobody (`undefined`: the caller logs it); any other topic notifies
 * nobody.
 */
@Injectable()
export class FanOut {
  constructor(
    private readonly changeSets: ChangeSetStore,
    private readonly branches: ChangeSetBranches,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly users: UserDirectory,
  ) {}

  /** A `People` reading the user directory once, at its first call. */
  people(): People {
    let read: Promise<readonly Actor[]> | undefined;
    return () => {
      read ??= this.readPeople().catch((error: unknown) => {
        read = undefined;
        throw error;
      });
      return read;
    };
  }

  /**
   * The notifications `event` makes; undefined when its payload is not
   * what its topic writes.
   */
  async of(
    event: OutboxEvent,
    people: People,
  ): Promise<NewNotification[] | undefined> {
    const kind = event.topic as NotificationKind;
    const made = await this.addressed(event, people);
    if (made === undefined) return undefined;
    if (made === 'no-rule') return [];
    const seen = new Set<string>();
    const out: NewNotification[] = [];
    for (const { recipient, payload } of made.to) {
      // Only a user's ID (what the table checks too): a row naming
      // anything else must not hold up the batch it is in.
      if (seen.has(recipient) || !UserId.safeParse(recipient).success) continue;
      if (made.cause?.kind === 'user' && made.cause.id === recipient) continue;
      seen.add(recipient);
      out.push({
        outboxId: event.position.id,
        recipient,
        kind,
        subject: made.subject,
        payload,
        createdAt: event.createdAt,
      });
    }
    return out;
  }

  private async addressed(
    event: OutboxEvent,
    people: People,
  ): Promise<
    | {
        subject: NotificationSubject;
        cause: EventActor | undefined;
        to: Addressed[];
      }
    | 'no-rule'
    | undefined
  > {
    switch (event.topic) {
      case 'change-set.submit':
      case 'change-set.return':
      case 'change-set.approve':
      case 'change-set.sign-off':
      case 'change-set.merge': {
        const parsed = Transition.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        const changeSet = await this.changeSets.find(p.changeSetId);
        if (!changeSet) return undefined;
        const payload = {
          changeSetId: changeSet.id,
          title: changeSet.title,
          by: p.actor,
          ...(p.to !== undefined && { state: p.to }),
          ...(p.reason !== undefined && { reason: p.reason }),
        };
        const to =
          event.topic === 'change-set.submit'
            ? await this.reviewersOf(changeSet, p.head ?? undefined, people)
            : authorOf(changeSet);
        return {
          subject: { type: 'change-set', id: changeSet.id },
          cause: p.actor,
          to: to.map((recipient) => ({ recipient, payload })),
        };
      }
      case 'lock.break': {
        const parsed = LockBreak.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        const changeSet = await this.changeSets.find(p.changeSetId);
        if (!changeSet) return undefined;
        const payload = {
          changeSetId: changeSet.id,
          title: changeSet.title,
          by: p.actor,
          count: p.count,
          subjects: p.subjects.slice(0, MAX_NAMED_SUBJECTS),
        };
        // The holder took the locks for their own change set: they know of
        // every subject named.
        const to =
          p.holder.kind === 'user' &&
          changeSet.author.kind === 'user' &&
          changeSet.author.id === p.holder.id
            ? [p.holder.id]
            : [];
        return {
          subject: { type: 'change-set', id: changeSet.id },
          cause: p.actor,
          to: to.map((recipient) => ({ recipient, payload })),
        };
      }
      case 'translation.imported':
      case 'translation.import-failed': {
        const parsed = Import.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        const payload = {
          importId: p.importId,
          ...(p.changeSetId !== undefined && { changeSetId: p.changeSetId }),
        };
        return {
          subject: { type: 'import', id: p.importId },
          cause: p.actor,
          to:
            p.importer.kind === 'user'
              ? [{ recipient: p.importer.id, payload }]
              : [],
        };
      }
      case 'release.output-failed':
      case 'release.output-recovered': {
        const parsed = OutputFailed.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        const covers =
          p.kind === 'offline-package'
            ? await this.levelRule(p.commit, p.audience ?? undefined)
            : await this.manualRule(p.commit, p.manualId);
        const payload = { releaseId: p.releaseId, manualId: p.manualId };
        const to = covers
          ? (await people()).filter((a) => covers(a, 'release.publish'))
          : [];
        return {
          subject: { type: 'release', id: p.releaseId },
          cause: p.actor,
          to: to.map((a) => ({ recipient: a.id, payload })),
        };
      }
      case 'release.published': {
        const parsed = ReleasePublished.safeParse(event.payload);
        if (!parsed.success) return undefined;
        const p = parsed.data;
        const subject = { type: 'release', id: p.releaseId } as const;
        if (p.level !== 'major') return { subject, cause: p.actor, to: [] };
        const rules = await Promise.all(
          [...new Set(p.manualIds)].map(
            async (id) => [id, await this.manualRule(p.commit, id)] as const,
          ),
        );
        const to: Addressed[] = [];
        for (const person of await people()) {
          const manualIds = rules
            .filter(([, covers]) => covers?.(person, 'content.read'))
            .map(([id]) => id);
          if (manualIds.length === 0) continue;
          to.push({
            recipient: person.id,
            payload: { releaseId: p.releaseId, level: p.level, manualIds },
          });
        }
        return { subject, cause: p.actor, to };
      }
      case 'backup.failed':
      case 'backup.overdue': {
        const parsed = (
          event.topic === 'backup.failed' ? BackupFailed : BackupOverdue
        ).safeParse(event.payload);
        if (!parsed.success) return undefined;
        const payload =
          event.topic === 'backup.failed'
            ? { error: (parsed.data as z.infer<typeof BackupFailed>).error }
            : {
                lastGoodAt: (parsed.data as z.infer<typeof BackupOverdue>)
                  .lastGoodAt,
                warnAfterHours: (parsed.data as z.infer<typeof BackupOverdue>)
                  .warnAfterHours,
              };
        const id =
          event.topic === 'backup.failed'
            ? (parsed.data as z.infer<typeof BackupFailed>).runId
            : 'instance';
        const to = (await people()).filter((a) =>
          allows(a, 'admin.backups', ANYWHERE),
        );
        return {
          subject: { type: 'backup', id },
          cause: undefined,
          to: to.map((a) => ({ recipient: a.id, payload })),
        };
      }
      default:
        return 'no-rule';
    }
  }

  /**
   * The people who may review all of `changeSet` as submitted at `head`:
   * `content.review` and `content.read.draft` over everything it changes
   * there, from its base commit. Not its author.
   */
  private async reviewersOf(
    changeSet: ChangeSet,
    head: string | undefined,
    people: People,
  ): Promise<string[]> {
    if (head === undefined) return [];
    const [base, at] = await Promise.all([
      this.openSnapshot.handle({ actor: NOTIFIER, ref: changeSet.baseCommit }),
      this.openSnapshot.handle({ actor: NOTIFIER, ref: head }),
    ]);
    if (base.commit !== changeSet.baseCommit || at.commit !== head) {
      throw new Error('A commit opened as another; refusing to fan out.');
    }
    const changes = await reviewedChanges(this.branches, changeSet, base, at);
    return (await people())
      .filter(
        (person) =>
          !(
            changeSet.author.kind === 'user' &&
            changeSet.author.id === person.id
          ) &&
          coversChanges(person, 'content.review', changes) &&
          coversChanges(person, 'content.read.draft', changes),
      )
      .map((person) => person.id);
  }

  /**
   * Whether a person holds a permission over the manual `manualId` as it
   * is at `commit` (its audience; a broken manifest: the most restricted
   * level); undefined when the manual is not there.
   */
  private async manualRule(
    commit: string,
    manualId: string,
  ): Promise<((person: Actor, permission: Permission) => boolean) | undefined> {
    const at = await this.openSnapshot.handle({ actor: NOTIFIER, ref: commit });
    const manifest = await at.manifestForCheck(manualId);
    if (manifest === undefined) return undefined;
    const config = await at.config();
    const target = {
      audiences: config.audiences.map((a) => a.id),
      audience: manifest === 'unreadable' ? undefined : manifest.audience,
      lang: undefined,
    };
    return (person, permission) => allowsManual(person, permission, target);
  }

  /**
   * Who an offline package (#59) of `audience` concerns, judged at `commit`
   * as a manual of that audience is: the package holds what that level reads.
   */
  private async levelRule(
    commit: string,
    audience: string | undefined,
  ): Promise<(person: Actor, permission: Permission) => boolean> {
    const at = await this.openSnapshot.handle({ actor: NOTIFIER, ref: commit });
    const config = await at.config();
    const target = {
      audiences: config.audiences.map((a) => a.id),
      audience,
      lang: undefined,
    };
    return (person, permission) => allowsManual(person, permission, target);
  }

  /** Every active user with a role, as actors, by ID: at most `MAX_PEOPLE`. */
  private async readPeople(): Promise<readonly Actor[]> {
    const found: Actor[] = [];
    for (let number = 1; found.length < MAX_PEOPLE; number++) {
      const page = await this.users.listUsers(
        { number, size: PEOPLE_PAGE },
        // A deactivated user acts as nobody, and hears of nothing.
        { active: true },
      );
      for (const user of page.items) {
        if (user.roleIds.length === 0 || found.length >= MAX_PEOPLE) continue;
        const actor = await this.users.findActor(user.id);
        if (actor?.kind === 'user') found.push(actor);
      }
      if (number * PEOPLE_PAGE >= page.total || page.items.length === 0) break;
    }
    return found;
  }
}

/** The change set's author, when a person. */
function authorOf(changeSet: ChangeSet): string[] {
  return changeSet.author.kind === 'user' ? [changeSet.author.id] : [];
}
