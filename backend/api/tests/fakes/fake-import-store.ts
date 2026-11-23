import type { Transaction } from '../../src/base/core/unit-of-work.js';
import type { ImportRecord } from '../../src/imports/core/import.js';
import {
  type ImportChange,
  ImportStore,
} from '../../src/imports/core/import-store.js';
import { fakeOf } from './fake-unit-of-work.js';

/**
 * Stored imports in memory, with `FakeUnitOfWork`: writes are kept only
 * when their transaction commits. `rows` maps each by ID.
 */
export class FakeImportStore extends ImportStore {
  readonly rows = new Map<string, ImportRecord>();

  async insert(tx: Transaction, record: ImportRecord): Promise<void> {
    if (this.rows.has(record.id)) throw new Error('duplicate import ID');
    fakeOf(tx).onCommit(() => this.rows.set(record.id, record));
  }

  async find(id: string): Promise<ImportRecord | undefined> {
    return this.rows.get(id);
  }

  async lock(tx: Transaction, id: string): Promise<ImportRecord | undefined> {
    fakeOf(tx);
    return this.rows.get(id);
  }

  async update(
    tx: Transaction,
    id: string,
    change: ImportChange,
  ): Promise<void> {
    fakeOf(tx).onCommit(() => {
      const row = this.rows.get(id);
      if (row) this.rows.set(id, { ...row, ...change });
    });
  }

  async expired(now: Date, limit: number): Promise<ImportRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.state !== 'applying' && r.expiresAt <= now)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
      .slice(0, limit);
  }

  async remove(tx: Transaction, id: string): Promise<void> {
    fakeOf(tx).onCommit(() => this.rows.delete(id));
  }

  async othersWithUpload(
    tx: Transaction,
    sha256: string,
    except: string,
  ): Promise<string[]> {
    fakeOf(tx);
    return [...this.rows.values()]
      .filter((r) => r.id !== except && r.upload.sha256 === sha256)
      .map((r) => r.id);
  }

  async takeOverUpload(tx: Transaction, id: string): Promise<void> {
    fakeOf(tx).onCommit(() => {
      const row = this.rows.get(id);
      if (row) {
        this.rows.set(id, { ...row, upload: { ...row.upload, created: true } });
      }
    });
  }
}
