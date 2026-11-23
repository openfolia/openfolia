import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { NotFoundError, UnprocessableError } from '../../base/core/errors.js';
import { Recent } from '../../base/core/recent.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ChangeSet, ChangeSetState } from './change-set.js';
import { ChangeSetBranches } from './change-set-branches.js';
import { ChangeSetStore } from './change-set-store.js';
import { subjectPath } from './commit.js';
import { seenOnBoth } from './diff-sides.js';
import { opensAsAuthor, readsChangeSets } from './own-work.js';
import { changedPathsWithin } from './review-scope.js';

/** The most open change sets looked at (the newest). */
export const OPEN_CHANGE_SETS_CHECKED = 500;

/** How many change sets' changed paths (per base and head commit) are kept. */
export const CHANGED_PATHS_KEPT = 1000;

/** How many change sets' changed paths are read from Git at once. */
const DIFFS_AT_ONCE = 8;

/** An open change set that changes a module. */
export interface TouchingChangeSet {
  readonly id: string;
  readonly state: ChangeSetState;
}

/** A module in one language. */
export interface ModuleKey {
  readonly id: string;
  readonly lang: string;
}

/** `<lang>/<id>`, as module resources are named. */
export const moduleKey = ({ id, lang }: ModuleKey): string => `${lang}/${id}`;

/**
 * Which open change sets (`draft`, `in-review`, `approved`) change which
 * modules: those whose files differ between the change set's base commit
 * and its head (the review head once submitted, else its branch's).
 * Derived from Git each time, never stored; the changed paths of a pair of
 * commits never change, so the last `CHANGED_PATHS_KEPT` are kept.
 *
 * Only change sets the actor may read are counted (every one for a holder
 * of `content.read.draft`, else only their own: `readsChangeSets`), and a
 * change set counts for a module only where its diff
 * (`ListChangeSetChangesAction`) would list the module for the actor: seen
 * on its head or at its base, through what they see on both
 * (`seenOnBoth`), so a change set changing it only where it lies outside
 * their scope is not named. It counts by the files that differ, so a
 * change that leaves the parsed module the same (formatting only) names
 * the change set though its diff lists nothing; a change set past
 * `MAX_REVIEWED_PATHS` (whose diff is refused) is named for none.
 */
@Injectable()
export class ChangeSetTouches {
  readonly #paths = new Recent<ReadonlySet<string>>(CHANGED_PATHS_KEPT);

  constructor(
    private readonly store: ChangeSetStore,
    private readonly branches: ChangeSetBranches,
    private readonly openSnapshot: OpenSnapshotAction,
  ) {}

  /** Per `moduleKey`, the open change sets changing it, newest first. */
  async of(
    actor: Actor,
    modules: readonly ModuleKey[],
  ): Promise<Map<string, TouchingChangeSet[]>> {
    const result = new Map<string, TouchingChangeSet[]>(
      modules.map((m) => [moduleKey(m), []]),
    );
    if (modules.length === 0) return result;
    const open = await this.store.listOpen(
      OPEN_CHANGE_SETS_CHECKED,
      readsChangeSets(actor) ? undefined : { kind: actor.kind, id: actor.id },
    );
    if (open.length === 0) return result;
    const heads = new Map(
      (await this.branches.list()).map((b) => [b.name, b.commit]),
    );
    // In batches, in order: the lists stay newest first.
    for (let i = 0; i < open.length; i += DIFFS_AT_ONCE) {
      const batch = await Promise.all(
        open
          .slice(i, i + DIFFS_AT_ONCE)
          .map((changeSet) =>
            this.touched(
              actor,
              changeSet,
              heads.get(changeSet.branch),
              modules,
            ),
          ),
      );
      for (const touched of batch.flat()) {
        result.get(touched.module)?.push(touched.changeSet);
      }
    }
    return result;
  }

  /** The modules of `modules` that `changeSet` changes, as the actor sees them. */
  private async touched(
    actor: Actor,
    changeSet: ChangeSet,
    branchHead: string | undefined,
    modules: readonly ModuleKey[],
  ): Promise<{ module: string; changeSet: TouchingChangeSet }[]> {
    const head = changeSet.reviewHead ?? branchHead;
    if (head === undefined) return [];
    const paths = await this.changedModules(changeSet.baseCommit, head);
    const changed = modules.filter((m) =>
      paths.has(subjectPath({ type: 'module', lang: m.lang, moduleId: m.id })),
    );
    if (changed.length === 0) return [];
    // As the change set's diff reads it (`ListChangeSetChangesAction`):
    // the head by the branch's name where it is its head (an author opens
    // their own branch so, #126), else by commit; the base by commit, for
    // its author as released content when it started from that. A side
    // that does not open shows nothing.
    const [at, base] = await Promise.all([
      this.open(actor, head === branchHead ? changeSet.branch : head, head),
      this.open(
        actor,
        changeSet.baseCommit,
        changeSet.baseCommit,
        opensAsAuthor(actor, changeSet),
      ),
    ]);
    if (!at || !base) return [];
    const seen: { module: string; changeSet: TouchingChangeSet }[] = [];
    for (const m of changed) {
      const subject = { type: 'module', lang: m.lang, moduleId: m.id } as const;
      const sides = [
        await seenOnBoth(at, base, subject),
        await seenOnBoth(base, at, subject),
      ];
      // A broken file does not count.
      if (sides.some((side) => side !== undefined && side !== 'unreadable')) {
        seen.push({
          module: moduleKey(m),
          changeSet: { id: changeSet.id, state: changeSet.state },
        });
      }
    }
    return seen;
  }

  /**
   * The module files that differ between `base` and `head`; none for a
   * change set past `MAX_REVIEWED_PATHS` (its diff is refused too).
   */
  private changedModules(base: string, head: string) {
    return this.#paths.get(`${base}..${head}`, async () => {
      try {
        const changed = await changedPathsWithin(this.branches, base, head);
        return new Set(
          changed.map((c) => c.path).filter((p) => p.startsWith('modules/')),
        );
      } catch (error) {
        if (error instanceof UnprocessableError) return new Set<string>();
        throw error;
      }
    });
  }

  /** `ref` as the actor may read it, when it is `commit`; else undefined. */
  private async open(
    actor: Actor,
    ref: string,
    commit: string,
    authoredBase = false,
  ): Promise<ReadableContent | undefined> {
    try {
      const opened = await this.openSnapshot.handle({
        actor,
        ref,
        ...(authoredBase && { authoredBase }),
      });
      return opened.commit === commit ? opened : undefined;
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}
