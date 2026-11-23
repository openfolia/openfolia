import type { PageRequest, Paginated } from '../../base/core/paging.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import type {
  NewRelease,
  Release,
  ReleaseFilter,
  ReleaseWithdrawal,
} from './release.js';

/**
 * A release as stored: reserved first (`tagObject` null: its tag may not
 * exist yet), then published once its tag is made (`CreateReleaseAction`).
 */
export type StoredRelease = NewRelease & {
  readonly tagObject: string | null;
};

/**
 * Port: the releases (Postgres; the tags themselves are in Git). A row is
 * never changed once published, and never deleted then.
 */
export abstract class ReleaseStore {
  /**
   * Reserves the release's name inside `tx`: a row without its tag object.
   * False, writing nothing, when a release (published or reserved) holds
   * its product and revision, or its tag name, already.
   */
  abstract reserve(tx: Transaction, release: NewRelease): Promise<boolean>;

  /**
   * Publishes the reserved release `id` with its tag object, inside `tx`;
   * false when it is not reserved (published already, or gone).
   */
  abstract publish(
    tx: Transaction,
    id: string,
    tagObject: string,
  ): Promise<boolean>;

  /** Drops the reservation `id`, inside `tx`; a published release stays. */
  abstract discard(tx: Transaction, id: string): Promise<void>;

  /**
   * The release (published or reserved) holding `product` at `revision`,
   * or the tag name `tag`.
   */
  abstract findByName(
    product: string,
    revision: string,
    tag: string,
  ): Promise<StoredRelease | undefined>;

  /** The published release `id`; undefined for none (or a malformed ID). */
  abstract find(id: string): Promise<Release | undefined>;

  /**
   * The published release of `product` at `revision`; undefined for none (reserved ones
   * are not published).
   */
  abstract findByRevision(
    product: string,
    revision: string,
  ): Promise<Release | undefined>;

  /**
   * The product's latest release (#450, what its stable addresses open): the newest
   * published one (by `publishedAt`, then ID) that is not withdrawn and was cut from
   * `main`, not from a maintenance line; undefined for none.
   */
  abstract latest(product: string): Promise<Release | undefined>;

  /**
   * Every product's latest release (#139, the download centre's current files): what `latest`
   * gives for each product that has one, by product.
   */
  abstract latestOfEach(): Promise<Release[]>;

  /**
   * The product's releases cut from `main` (#139, a download's versions), withdrawn ones too,
   * newest first (by `publishedAt`, then ID), at most `max`; `truncated` when there are more.
   */
  abstract mainLine(
    product: string,
    max: number,
  ): Promise<{ releases: Release[]; truncated: boolean }>;

  /** One page of the published releases matching `filter`, newest first. */
  abstract list(
    filter: ReleaseFilter,
    page: PageRequest,
  ): Promise<Paginated<Release>>;

  /**
   * The release a release's changes are counted from (#138): the newest
   * published release of the same product before it (by `publishedAt`,
   * then ID) that is not withdrawn; undefined for its product's first.
   * `among` narrows it to the releases of one maintenance line
   * (`{ line }`), or to those of no line (`{ line: null }`: `main`'s own,
   * #60).
   */
  abstract previous(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    among?: { readonly line: string | null },
  ): Promise<Release | undefined>;

  /**
   * The product's published releases cut after `release` (by `publishedAt`, then ID), withdrawn
   * ones too, oldest first, at most `limit` (#497: the releases planned before it that may
   * share its files).
   */
  abstract after(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    limit: number,
  ): Promise<Release[]>;

  /**
   * The product's published releases cut before `release` (by `publishedAt`, then ID), withdrawn
   * ones too, oldest first: the nearest `limit` (#527: those planned before it, in the order
   * they were cut).
   */
  abstract before(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    limit: number,
  ): Promise<Release[]>;

  /**
   * Withdraws the published release `id` inside `tx` (#138); false,
   * writing nothing, when it is withdrawn already. Never changes the
   * release itself, nor its tag.
   */
  abstract withdraw(
    tx: Transaction,
    id: string,
    withdrawal: ReleaseWithdrawal,
  ): Promise<boolean>;
}
