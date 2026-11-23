import {
  ConflictError,
  UnprocessableError,
} from '../../src/base/core/errors.js';
import { paginate, type PageRequest } from '../../src/base/core/paging.js';
import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { ChangeSetAuthor } from '../../src/change-sets/core/change-set.js';
import { MaintenanceBranches } from '../../src/releases/core/maintenance-branches.js';
import {
  DEFAULT_MAINTENANCE_BRANCH,
  type MaintenanceLine,
  type MaintenanceLineFilter,
  maintenanceBranchName,
} from '../../src/releases/core/maintenance-line.js';
import { MaintenanceLineStore } from '../../src/releases/core/maintenance-line-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Maintenance lines in memory, with `FakeUnitOfWork`: writes are kept only
 * when their transaction commits. Unique by base release, product and
 * revision, and branch (in any case), as the table's indexes hold them.
 * `released` maps a release ID to its line and the order cut (`linkRelease`);
 * `publishedAt` says when each release was published, for `releasesOf`.
 */
export class FakeMaintenanceLineStore extends MaintenanceLineStore {
  readonly rows: MaintenanceLine[] = [];
  readonly released = new Map<string, string>();
  /** The share/update locks taken, for tests to look at. */
  readonly locked: { id: string; mode: 'update' | 'share' }[] = [];

  async insert(tx: Transaction, line: MaintenanceLine): Promise<boolean> {
    const transaction = fakeOf(tx);
    if (
      this.rows.some(
        (r) =>
          r.baseRelease === line.baseRelease ||
          (r.product === line.product && r.revision === line.revision) ||
          r.branch.toLowerCase() === line.branch.toLowerCase(),
      )
    ) {
      return false;
    }
    transaction.onCommit(() => this.rows.push(line));
    return true;
  }

  async find(id: string) {
    return this.rows.find((r) => r.id === id);
  }

  async findByBranch(branch: string) {
    return this.rows.find(
      (r) => r.branch.toLowerCase() === branch.toLowerCase(),
    );
  }

  async findByRelease(releaseId: string) {
    return this.rows.find((r) => r.baseRelease === releaseId);
  }

  async lock(tx: Transaction, id: string, mode: 'update' | 'share') {
    fakeOf(tx);
    this.locked.push({ id, mode });
    return this.find(id);
  }

  async close(
    tx: Transaction,
    id: string,
    closing: { readonly by: ChangeSetAuthor; readonly at: Date },
  ): Promise<boolean> {
    const transaction = fakeOf(tx);
    const index = this.rows.findIndex((r) => r.id === id && !r.closedAt);
    if (index < 0) return false;
    transaction.onCommit(() => {
      const row = this.rows[index] as MaintenanceLine;
      this.rows[index] = { ...row, closedAt: closing.at, closedBy: closing.by };
    });
    return true;
  }

  async list(filter: MaintenanceLineFilter, page: PageRequest) {
    const all = this.rows
      .filter(
        (r) =>
          (filter.product === undefined || r.product === filter.product) &&
          (filter.state === undefined ||
            (filter.state === 'open') === (r.closedAt === null)),
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.id.localeCompare(a.id),
      );
    return paginate(all, page);
  }

  async linkRelease(
    tx: Transaction,
    lineId: string,
    releaseId: string,
  ): Promise<void> {
    fakeOf(tx).onCommit(() => this.released.set(releaseId, lineId));
  }

  async lineOfRelease(releaseId: string) {
    const lineId = this.released.get(releaseId);
    return lineId === undefined ? undefined : this.find(lineId);
  }

  async releasesOf(lineId: string, page: PageRequest) {
    const ids = [...this.released]
      .filter(([, line]) => line === lineId)
      .map(([release]) => release)
      .reverse();
    return paginate(ids, page);
  }
}

/**
 * Maintenance branches in memory, named by the default pattern: `heads`
 * maps a name to its commit. Creating one that exists elsewhere is 409.
 */
export class FakeMaintenanceBranches extends MaintenanceBranches {
  readonly heads = new Map<string, string>();

  nameOf(product: string, revision: string): string {
    const name = maintenanceBranchName(
      DEFAULT_MAINTENANCE_BRANCH,
      product,
      revision,
    );
    if (name === undefined) {
      throw new UnprocessableError('invalid-maintenance-branch', 'no name');
    }
    return name;
  }

  async create(name: string, commit: string): Promise<'created' | 'existed'> {
    const at = this.heads.get(name);
    if (at === commit) return 'existed';
    if (at !== undefined) {
      throw new ConflictError('branch-exists', `${name} exists`);
    }
    this.heads.set(name, commit);
    return 'created';
  }

  async head(name: string): Promise<string | undefined> {
    return this.heads.get(name);
  }
}
