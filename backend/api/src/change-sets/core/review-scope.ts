import {
  CONFIG_FILE_NAME,
  isConfigFileName,
  type ModuleMeta,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import {
  allows,
  allowsAllIn,
  allowsManual,
  allowsUnrestricted,
  moduleTarget,
} from '../../access/core/allows.js';
import type { Permission } from '../../access/core/permissions.js';
import { UnprocessableError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { REVIEW, type Requirement, signOff } from './approval.js';
import type { ChangeSet } from './change-set.js';
import type { ChangeSetBranches } from './change-set-branches.js';
import { subjectOfPath } from './commit.js';
import type { LockSubject } from './lock.js';

/**
 * The most files one review takes in (the diff between a change set's base
 * commit and its review head); past it the change set is split.
 */
export const MAX_REVIEWED_PATHS = 10_000;

/** A changed subject as one side of the change (base or head) has it. */
type Side =
  | {
      readonly config: ProjectConfig;
      readonly subject: Extract<LockSubject, { type: 'module' }>;
      readonly meta: ModuleMeta | 'unreadable';
    }
  | {
      readonly config: ProjectConfig;
      readonly subject: Extract<LockSubject, { type: 'manual' }>;
      readonly audience: string | undefined | 'unreadable';
    };

/**
 * What a change set changes, for deciding who may review, sign off, return
 * or merge it: each changed module and manual as it is at its base commit
 * and at its head (where it exists there), read past the reading filter
 * (for checks only, never for a response), and the changed paths that are
 * no module's or manual's file.
 */
export interface ReviewedChanges {
  readonly sides: readonly Side[];
  readonly others: readonly string[];
  /**
   * The configurations at the base commit, at the head and at the base
   * branch's tip, whatever changed: which module types are restricted is
   * read from all of them (a union, so neither side drops a restriction).
   */
  readonly configs: readonly ProjectConfig[];
}

/** The configuration file; a change to it needs every sign-off. */
export const CONFIG_PATH = CONFIG_FILE_NAME;

/**
 * The files that differ between a change set's base commit `from` and a
 * head `to` (`ChangeSetBranches.changedPaths`): what review and the change
 * set's diff both take in. 422 `too-many-changes` past `MAX_REVIEWED_PATHS`.
 */
export async function changedPathsWithin(
  branches: Pick<ChangeSetBranches, 'changedPaths'>,
  from: string,
  to: string,
): Promise<{ path: string; deleted: boolean }[]> {
  const changed = await branches.changedPaths(from, to);
  if (changed.length > MAX_REVIEWED_PATHS) {
    throw new UnprocessableError(
      'too-many-changes',
      `A change set reviewed at once changes at most ${MAX_REVIEWED_PATHS} files.`,
      { max: MAX_REVIEWED_PATHS },
    );
  }
  return changed;
}

/**
 * The changes from the change set's base commit to `head.commit`, read in
 * `base` (at the base commit) and `head`. 422 `too-many-changes` past
 * `MAX_REVIEWED_PATHS`.
 */
export async function reviewedChanges(
  branches: Pick<ChangeSetBranches, 'changedPaths'>,
  changeSet: Pick<ChangeSet, 'baseCommit'>,
  base: ReadableContent,
  head: ReadableContent,
  /** More configurations restricted types are read from (the base branch's tip). */
  extraConfigs: readonly ProjectConfig[] = [],
): Promise<ReviewedChanges> {
  const changed = await changedPathsWithin(
    branches,
    changeSet.baseCommit,
    head.commit,
  );
  const sides: Side[] = [];
  const others: string[] = [];
  const configs = [await base.config(), await head.config(), ...extraConfigs];
  for (const { path } of changed) {
    const subject = subjectOfPath(path);
    // The configuration and terms are checked as any other file: only a
    // role whose scope restricts nothing covers them.
    if (!subject || (subject.type !== 'module' && subject.type !== 'manual')) {
      others.push(path);
      continue;
    }
    const before = sides.length;
    for (const snapshot of [base, head]) {
      const config = await snapshot.config();
      if (subject.type === 'module') {
        const meta = await snapshot.moduleMetaForCheck(
          subject.moduleId,
          subject.lang,
        );
        if (meta !== undefined) sides.push({ config, subject, meta });
      } else {
        const manifest = await snapshot.manifestForCheck(subject.manualId);
        if (manifest !== undefined) {
          sides.push({
            config,
            subject,
            audience:
              manifest === 'unreadable' ? 'unreadable' : manifest.audience,
          });
        }
      }
    }
    // A subject's path that neither side reads as one is checked as any
    // other file: fail closed.
    if (sides.length === before) others.push(path);
  }
  return { sides, others, configs };
}

/**
 * Whether `actor` holds `permission` over everything `changes` touches,
 * on both sides: each module within one role's scope (a broken file: a
 * role covering all of its language), each manual's audience within one
 * role's (a broken file: every audience), and any other file only through
 * a role whose scope restricts nothing (it may be configuration or a
 * template, which no narrower scope can be said to cover). Fails closed.
 */
export function coversChanges(
  actor: Actor,
  permission: Permission,
  changes: ReviewedChanges,
): boolean {
  if (changes.others.length > 0 && !allowsUnrestricted(actor, permission)) {
    return false;
  }
  return changes.sides.every((side) => coversSide(actor, permission, side));
}

function coversSide(actor: Actor, permission: Permission, side: Side): boolean {
  if (side.subject.type === 'module' && 'meta' in side) {
    return side.meta === 'unreadable'
      ? allowsAllIn(actor, permission, side.subject.lang)
      : allows(actor, permission, moduleTarget(side.meta, side.config));
  }
  if (!('audience' in side)) return false;
  return allowsManual(actor, permission, {
    audiences: side.config.audiences.map((a) => a.id),
    // A broken manifest: the most restricted level, so only a role
    // covering every audience.
    audience: side.audience === 'unreadable' ? undefined : side.audience,
    lang: undefined,
  });
}

/** Whether some role holds `permission` with a scope that restricts nothing. */
export { allowsUnrestricted };

/**
 * The restricted module types: those any of `changes.configs` (base
 * commit, head, base branch tip) or a side's configuration marks
 * `restricted: true`, so a change set that also edits `openfolia.yaml` cannot
 * drop a sign-off by un-restricting a type on its own branch, and one
 * restricted on the base since it started is not missed.
 */
function restrictedTypes(changes: ReviewedChanges): string[] {
  const types = new Set<string>();
  for (const config of changes.configs) {
    for (const t of config.moduleTypes) if (t.restricted) types.add(t.id);
  }
  for (const side of changes.sides) {
    for (const t of side.config.moduleTypes) if (t.restricted) types.add(t.id);
  }
  return [...types];
}

/**
 * The restricted types a changed module side counts under: its type when
 * that is restricted, and every restricted type for a broken file (whose
 * type cannot be read), so a broken file never skips a sign-off.
 */
function typesOf(side: Side, restricted: readonly string[]): string[] {
  if (!('meta' in side)) return [];
  if (side.meta === 'unreadable') return [...restricted];
  const type = side.meta.type;
  return type !== undefined && restricted.includes(type) ? [type] : [];
}

/**
 * What the change set needs before it is approved: the review, and a
 * sign-off for every restricted module type a changed module has on
 * either side, in type order; every restricted type when the change set
 * changes `openfolia.yaml` itself.
 */
export function requirementsOf(changes: ReviewedChanges): Requirement[] {
  const restricted = restrictedTypes(changes);
  // The configuration decides what is restricted: changing it is
  // privileged, so it needs every sign-off there is.
  const types = new Set(
    configChanged(changes)
      ? restricted
      : changes.sides.flatMap((s) => typesOf(s, restricted)),
  );
  return [REVIEW, ...[...types].sort().map(signOff)];
}

/**
 * Whether `actor` may sign off the restricted type `type`: they hold
 * `content.approve` over every changed module counted under it, on both
 * sides (a broken file: all of its language), and, when the change set
 * changes `openfolia.yaml`, a role approving all of that type.
 */
export function signsOff(
  actor: Actor,
  type: string,
  changes: ReviewedChanges,
): boolean {
  const restricted = restrictedTypes(changes);
  if (!restricted.includes(type)) return false;
  const counted = changes.sides.filter((side) =>
    typesOf(side, restricted).includes(type),
  );
  if (configChanged(changes)) {
    // The configuration's own change: only an approver for the whole type.
    if (!approvesWholeType(actor, type)) return false;
  } else if (counted.length === 0) {
    return false;
  }
  return counted.every((side) => coversSide(actor, 'content.approve', side));
}

/** Whether the change set changes the configuration file. */
function configChanged(changes: ReviewedChanges): boolean {
  // Under either name: `ccms.yaml` is still read for one release.
  return changes.others.some(isConfigFileName);
}

/**
 * Whether some role holds `content.approve` for all of module type `type`:
 * its scope restricts nothing but module types, and those include it.
 */
function approvesWholeType(actor: Actor, type: string): boolean {
  return actor.roles.some(
    ({ permissions, scope }) =>
      permissions.includes('content.approve') &&
      Object.entries(scope).every(
        ([dimension, value]) =>
          dimension === 'moduleTypes' || value === undefined,
      ) &&
      (scope.moduleTypes === undefined || scope.moduleTypes.includes(type)),
  );
}
