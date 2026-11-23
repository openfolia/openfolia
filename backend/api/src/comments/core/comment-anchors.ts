import { type ModuleMeta, walk } from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import { allows, allowsAllIn, moduleTarget } from '../../access/core/allows.js';
import type { Permission } from '../../access/core/permissions.js';
import { InvalidContentError } from '../../base/core/errors.js';
import type { ChangeSetSides } from '../../change-sets/core/change-set-sides.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type { ChangeSet } from '../../change-sets/core/change-set.js';
import { isActor } from '../../change-sets/core/own-work.js';
import { type CommentSubject, moduleKey } from './comment.js';

/** How many modules are checked against content at once. */
const CHECKED_AT_ONCE = 16;

/** Where a module is found for its comments: the side and its metadata there. */
interface Anchor {
  /** The head where the module is there, else the base, else neither. */
  readonly side: ReadableContent | undefined;
  /** Its metadata there, past the reading filter (for checks only); `'unreadable'` for a broken file. */
  readonly meta: ModuleMeta | 'unreadable' | undefined;
}

/**
 * What `actor` may know of the comments of one change set and do with
 * them, over its two sides (`openSides`: the base commit and the head, each
 * as the actor may read it).
 *
 * **Seeing** comments on a module follows seeing the module: where the
 * module is at the head, the reader must see it there (with the head's
 * read permission); where it is only at the base (the change set removed
 * it), there; where it is on neither side any more (added and removed
 * again), only a reader of all of its language on both sides sees them,
 * since a module that is gone and one that is hidden must look alike. A
 * comment the reader may not see is not there for them, exactly like a
 * missing one (lists are filtered before paging).
 *
 * **Writing** (a comment, a reply, resolving and reopening): the change
 * set's author, or a holder of `content.review` whose role covers the
 * module as it is found (`moduleTarget`; one on neither side, or a broken
 * file: a role covering all of its language).
 */
export class CommentAnchors {
  readonly #anchors = new Map<string, Promise<Anchor>>();
  readonly #blocks = new Map<string, Promise<BlockIds>>();

  constructor(
    private readonly actor: Actor,
    private readonly changeSet: ChangeSet,
    readonly sides: ChangeSetSides,
  ) {}

  /** Whether the actor may see comments on `subject`. */
  async sees(subject: CommentSubject): Promise<boolean> {
    const { side, meta } = await this.#anchor(subject);
    if (side === undefined) {
      return (
        allowsAllIn(this.actor, this.sides.head.permission, subject.lang) &&
        allowsAllIn(this.actor, this.sides.base.permission, subject.lang)
      );
    }
    return this.#covers(side, meta, side.permission, subject);
  }

  /** Of `subjects`, those the actor may see comments on, in their order. */
  async visible(
    subjects: readonly CommentSubject[],
  ): Promise<CommentSubject[]> {
    const seen: boolean[] = [];
    // A few at a time, so one request never reads Git for every module at once.
    for (let start = 0; start < subjects.length; start += CHECKED_AT_ONCE) {
      seen.push(
        ...(await Promise.all(
          subjects
            .slice(start, start + CHECKED_AT_ONCE)
            .map((s) => this.sees(s)),
        )),
      );
    }
    return subjects.filter((_, i) => seen[i]);
  }

  /**
   * Whether every comment is visible to the actor without looking at
   * content: some role holding each side's read permission restricts
   * nothing.
   */
  seesAll(): boolean {
    return [this.sides.head.permission, this.sides.base.permission].every(
      (permission) => restrictsNothing(this.actor, permission),
    );
  }

  /**
   * Whether the actor may write comments on `subject` (and resolve and
   * reopen its threads): the change set's author, or `content.review`
   * over the module. Call only for a subject the actor sees.
   */
  async mayWrite(subject: CommentSubject): Promise<boolean> {
    if (isActor(this.actor, this.changeSet.author)) return true;
    const { side, meta } = await this.#anchor(subject);
    if (side === undefined) {
      return allowsAllIn(this.actor, 'content.review', subject.lang);
    }
    return this.#covers(side, meta, 'content.review', subject);
  }

  /**
   * Whether `blockId` is in the module at the head or at the base, as the
   * actor sees it there: a new comment's block (one the change set removed
   * may be commented on too).
   */
  async hasBlock(subject: CommentSubject, blockId: string): Promise<boolean> {
    for (const side of [this.sides.head, this.sides.base]) {
      const ids = await this.#blockIds(side, subject);
      if (ids !== 'unreadable' && ids?.has(blockId)) return true;
    }
    return false;
  }

  /**
   * Whether a comment on `blockId` is orphaned: the module at the head (as
   * the actor sees it) does not hold the block, or is not there. A file
   * there that cannot be read tells nothing, so it is not.
   */
  async orphaned(subject: CommentSubject, blockId: string): Promise<boolean> {
    const ids = await this.#blockIds(this.sides.head, subject);
    return ids !== 'unreadable' && !ids?.has(blockId);
  }

  #anchor(subject: CommentSubject): Promise<Anchor> {
    const key = moduleKey(subject);
    let found = this.#anchors.get(key);
    if (!found) {
      found = (async () => {
        for (const side of [this.sides.head, this.sides.base]) {
          const meta = await side.moduleMetaForCheck(
            subject.moduleId,
            subject.lang,
          );
          if (meta !== undefined) return { side, meta };
        }
        return { side: undefined, meta: undefined };
      })();
      this.#anchors.set(key, found);
    }
    return found;
  }

  async #covers(
    side: ReadableContent,
    meta: ModuleMeta | 'unreadable' | undefined,
    permission: Permission,
    subject: CommentSubject,
  ): Promise<boolean> {
    if (meta === undefined || meta === 'unreadable') {
      return allowsAllIn(this.actor, permission, subject.lang);
    }
    return allows(
      this.actor,
      permission,
      moduleTarget(meta, await side.config()),
    );
  }

  /**
   * The IDs of every block, list item and procedure step of the module in
   * `side` as the actor sees it there; undefined when it is not there for
   * them, `'unreadable'` for a broken file (reported only to a reader of
   * all of its language; anyone else finds no module).
   */
  #blockIds(side: ReadableContent, subject: CommentSubject): Promise<BlockIds> {
    const key = `${side === this.sides.head ? 'head' : 'base'}|${moduleKey(subject)}`;
    let found = this.#blocks.get(key);
    if (!found) {
      found = (async () => {
        let module;
        try {
          module = await side.module(subject.moduleId, subject.lang);
        } catch (error) {
          if (error instanceof InvalidContentError) return 'unreadable';
          throw error;
        }
        if (!module) return undefined;
        return new Set([...walk(module.blocks)].map(({ node }) => node.id));
      })();
      this.#blocks.set(key, found);
    }
    return found;
  }
}

/** A module's block IDs at a side, as `#blockIds` finds them. */
type BlockIds = Set<string> | 'unreadable' | undefined;

/** Whether some role of `actor` holding `permission` restricts nothing. */
function restrictsNothing(actor: Actor, permission: Permission): boolean {
  return actor.roles.some(
    ({ permissions, scope }) =>
      permissions.includes(permission) &&
      Object.values(scope).every((value) => value === undefined),
  );
}
