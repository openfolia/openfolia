import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  ChangeSet,
  ChangeSetAuthor,
  ChangeSetFilter,
  ChangeSetState,
} from './change-set.js';

/** What editing a change set changes; every field optional. */
export interface ChangeSetEdit {
  readonly title?: string;
  /** `null` clears it. */
  readonly description?: string | null;
}

/** Where a walk through change sets stopped: the last one it looked at. */
export type ChangeSetCursor = Pick<ChangeSet, 'createdAt' | 'id'>;

/** Port: the change sets' operational state (Postgres). Git holds their content. */
export abstract class ChangeSetStore {
  /** Records a new change set inside `tx`. */
  abstract insert(tx: Transaction, changeSet: ChangeSet): Promise<void>;

  /** The change set `id`; undefined when there is none (or `id` is malformed). */
  abstract find(id: string): Promise<ChangeSet | undefined>;

  /** One page of the change sets matching `filter`, newest first. */
  abstract list(
    filter: ChangeSetFilter,
    page: PageRequest,
  ): Promise<Paginated<ChangeSet>>;

  /**
   * How many change sets match `filter` in each state (#481: the counts a
   * list's state filters show, in the list's own answer). `filter.state`
   * is ignored; a state none is in counts 0.
   */
  abstract countByState(
    filter: ChangeSetFilter,
  ): Promise<Record<ChangeSetState, number>>;

  /**
   * The change set `id`, read inside `tx` and locked until it ends, so no
   * concurrent transaction changes it meanwhile (`SELECT … FOR UPDATE`).
   */
  abstract lock(tx: Transaction, id: string): Promise<ChangeSet | undefined>;

  /**
   * Sets the state of the change set `id` (locked by `lock` in the same
   * `tx`) and returns it as it now is.
   */
  abstract setState(
    tx: Transaction,
    id: string,
    state: ChangeSetState,
  ): Promise<ChangeSet>;

  /**
   * Sets the title and description of the change set `id` (locked by
   * `lock` in the same `tx`) where given (`null` clears the description)
   * and returns it as it now is.
   */
  abstract edit(
    tx: Transaction,
    id: string,
    change: ChangeSetEdit,
  ): Promise<ChangeSet>;

  /**
   * Moves the base commit of the change set `id` (locked by `lock` in the
   * same `tx`) on, once its branch took that commit in (#22), with
   * whether it is released, and returns it as it now is.
   */
  abstract rebase(
    tx: Transaction,
    id: string,
    base: { readonly baseCommit: string; readonly baseReleased: boolean },
  ): Promise<ChangeSet>;

  /**
   * Moves the change set `id` (locked by `lock` in the same `tx`) to
   * `change.state`, setting or clearing (`null`) its review head and merge
   * commit where given, and returns it as it now is.
   */
  abstract transition(
    tx: Transaction,
    id: string,
    change: {
      readonly state: ChangeSetState;
      readonly reviewHead?: string | null;
      readonly mergeCommit?: string | null;
    },
  ): Promise<ChangeSet>;

  /**
   * The open change sets (`OPEN_STATES`), newest first, at most `max`;
   * only `author`'s when given.
   */
  abstract listOpen(
    max: number,
    author?: ChangeSetAuthor,
  ): Promise<ChangeSet[]>;

  /**
   * Up to `max` change sets in `state`, oldest first (by creation, then
   * ID), after `after` when given: keyset pages a background pass walks
   * through and resumes from where it stopped (the reconciler).
   */
  abstract listInState(
    state: ChangeSetState,
    max: number,
    after?: ChangeSetCursor,
  ): Promise<ChangeSet[]>;

  /** Which of `ids` have a change set (for the reconciler). */
  abstract existing(ids: readonly string[]): Promise<Set<string>>;
}
