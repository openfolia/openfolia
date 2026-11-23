import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type {
  NewRelease,
  Release,
  ReleaseFilter,
  ReleaseWithdrawal,
} from '../../src/releases/core/release.js';
import {
  ReleaseStore,
  type StoredRelease,
} from '../../src/releases/core/release-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Releases in memory, with `FakeUnitOfWork`: writes are kept only when
 * their transaction commits. Names are unique as the table's indexes hold
 * them (product and revision; the tag in any case). `rows` holds them in
 * the order they were reserved.
 */
export class FakeReleaseStore extends ReleaseStore {
  readonly rows: StoredRelease[] = [];
  /** Withdrawals by release ID. */
  readonly withdrawals = new Map<string, ReleaseWithdrawal>();

  async reserve(tx: Transaction, release: NewRelease): Promise<boolean> {
    const transaction = fakeOf(tx);
    if (this.holding(release.product, release.revision, release.tag)) {
      return false;
    }
    transaction.onCommit(() => this.rows.push({ ...release, tagObject: null }));
    return true;
  }

  async publish(
    tx: Transaction,
    id: string,
    tagObject: string,
  ): Promise<boolean> {
    const transaction = fakeOf(tx);
    const index = this.rows.findIndex(
      (r) => r.id === id && r.tagObject === null,
    );
    if (index < 0) return false;
    transaction.onCommit(() => {
      const row = this.rows[index];
      if (row) this.rows[index] = { ...row, tagObject };
    });
    return true;
  }

  async discard(tx: Transaction, id: string): Promise<void> {
    const transaction = fakeOf(tx);
    transaction.onCommit(() => {
      const index = this.rows.findIndex(
        (r) => r.id === id && r.tagObject === null,
      );
      if (index >= 0) this.rows.splice(index, 1);
    });
  }

  async findByName(
    product: string,
    revision: string,
    tag: string,
  ): Promise<StoredRelease | undefined> {
    return this.holding(product, revision, tag);
  }

  async find(id: string): Promise<Release | undefined> {
    return this.published().find((r) => r.id === id);
  }

  async list(filter: ReleaseFilter, page: PageRequest) {
    const all = this.published()
      .filter(
        (r) =>
          (filter.product === undefined || r.product === filter.product) &&
          (filter.major === undefined || r.major === filter.major) &&
          (filter.withdrawn === undefined ||
            (r.withdrawal !== null) === filter.withdrawn),
      )
      .sort(newestFirst);
    return paginate(all, page);
  }

  async findByRevision(product: string, revision: string) {
    return this.published().find(
      (r) => r.product === product && r.revision === revision,
    );
  }

  async latest(product: string) {
    return this.published()
      .filter(
        (r) =>
          r.product === product &&
          !r.withdrawal &&
          this.lineOf(r.id) === undefined,
      )
      .sort(newestFirst)[0];
  }

  async latestOfEach() {
    const products = [
      ...new Set(this.published().map((r) => r.product)),
    ].sort();
    const found: Release[] = [];
    for (const product of products) {
      const latest = await this.latest(product);
      if (latest) found.push(latest);
    }
    return found;
  }

  async mainLine(product: string, max: number) {
    const all = this.published()
      .filter((r) => r.product === product && this.lineOf(r.id) === undefined)
      .sort(newestFirst);
    return { releases: all.slice(0, max), truncated: all.length > max };
  }

  /** The maintenance line a release was cut from (#60), for `previous` and `latest`. */
  lineOf: (releaseId: string) => string | undefined = () => undefined;

  async previous(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    among?: { readonly line: string | null },
  ) {
    return this.published()
      .filter(
        (r) =>
          (among === undefined || (this.lineOf(r.id) ?? null) === among.line) &&
          r.product === release.product &&
          !r.withdrawal &&
          newestFirst(r, release) > 0,
      )
      .sort(newestFirst)[0];
  }

  async after(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    limit: number,
  ) {
    return this.published()
      .filter(
        (r) => r.product === release.product && newestFirst(release, r) > 0,
      )
      .sort((a, b) => newestFirst(b, a))
      .slice(0, limit);
  }

  async before(
    release: Pick<Release, 'id' | 'product' | 'publishedAt'>,
    limit: number,
  ) {
    return this.published()
      .filter(
        (r) => r.product === release.product && newestFirst(release, r) < 0,
      )
      .sort((a, b) => newestFirst(a, b))
      .slice(0, limit)
      .reverse();
  }

  async withdraw(tx: Transaction, id: string, withdrawal: ReleaseWithdrawal) {
    const transaction = fakeOf(tx);
    if (this.withdrawals.has(id)) return false;
    transaction.onCommit(() => this.withdrawals.set(id, withdrawal));
    return true;
  }

  private holding(product: string, revision: string, tag: string) {
    return this.rows.find(
      (r) =>
        (r.product === product && r.revision === revision) ||
        r.tag.toLowerCase() === tag.toLowerCase(),
    );
  }

  private published(): Release[] {
    return this.rows.flatMap((r) =>
      r.tagObject === null
        ? []
        : [
            {
              ...r,
              tagObject: r.tagObject,
              withdrawal: this.withdrawals.get(r.id) ?? null,
            },
          ],
    );
  }
}

/** Newest first: by `publishedAt`, then ID. */
function newestFirst(
  a: Pick<Release, 'id' | 'publishedAt'>,
  b: Pick<Release, 'id' | 'publishedAt'>,
): number {
  return (
    b.publishedAt.getTime() - a.publishedAt.getTime() ||
    b.id.localeCompare(a.id)
  );
}
