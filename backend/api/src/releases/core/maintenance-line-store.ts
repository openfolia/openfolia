import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import type {
  MaintenanceLine,
  MaintenanceLineFilter,
} from './maintenance-line.js';

/**
 * Port: the maintenance lines (Postgres; their branches are in Git), and
 * which releases were cut from which line. A line is never deleted; it is
 * closed once, and that is its only change.
 */
export abstract class MaintenanceLineStore {
  /**
   * Records `line` inside `tx`. False, writing nothing, when a line holds
   * its base release, its product and revision, or its branch already.
   */
  abstract insert(tx: Transaction, line: MaintenanceLine): Promise<boolean>;

  /** The line `id`; undefined for none (or a malformed ID). */
  abstract find(id: string): Promise<MaintenanceLine | undefined>;

  /** The line whose branch is `branch`, in any case; undefined for none. */
  abstract findByBranch(branch: string): Promise<MaintenanceLine | undefined>;

  /** The line started from the release `releaseId`; undefined for none. */
  abstract findByRelease(
    releaseId: string,
  ): Promise<MaintenanceLine | undefined>;

  /**
   * The line `id`, its row held in `tx` until it ends: `update` for
   * closing it (no change set starts on it meanwhile), `share` for
   * starting a change set on it (several at once, none while it closes).
   */
  abstract lock(
    tx: Transaction,
    id: string,
    mode: 'update' | 'share',
  ): Promise<MaintenanceLine | undefined>;

  /**
   * Closes the line `id` inside `tx`, holding its row; false, writing
   * nothing, when it is closed already.
   */
  abstract close(
    tx: Transaction,
    id: string,
    closing: { readonly by: ChangeSetAuthor; readonly at: Date },
  ): Promise<boolean>;

  /** One page of the lines matching `filter`, newest first. */
  abstract list(
    filter: MaintenanceLineFilter,
    page: PageRequest,
  ): Promise<Paginated<MaintenanceLine>>;

  /**
   * Records, inside `tx`, that the release `releaseId` (reserved in the
   * same transaction) is cut from the line `lineId`. A release dropped
   * before it is published takes this record with it.
   */
  abstract linkRelease(
    tx: Transaction,
    lineId: string,
    releaseId: string,
  ): Promise<void>;

  /** The line the release `releaseId` was cut from, if one. */
  abstract lineOfRelease(
    releaseId: string,
  ): Promise<MaintenanceLine | undefined>;

  /**
   * One page of the IDs of the published releases cut from the line
   * `lineId`, newest first (not its base release).
   */
  abstract releasesOf(
    lineId: string,
    page: PageRequest,
  ): Promise<Paginated<string>>;
}
