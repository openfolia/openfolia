import type { Transaction } from '../../base/core/unit-of-work.js';
import type { ImportRecord } from './import.js';

/** What an import's job changes on its record as it goes. */
export type ImportChange = Partial<
  Pick<
    ImportRecord,
    | 'state'
    | 'changeSetId'
    | 'progress'
    | 'failure'
    | 'startedAt'
    | 'finishedAt'
    | 'expiresAt'
  >
>;

/** Port: stored imports (Postgres, `imports`), each for an hour after its upload. */
export abstract class ImportStore {
  abstract insert(tx: Transaction, record: ImportRecord): Promise<void>;

  /** The import, or `undefined` (also for an ID that names none, malformed or not). */
  abstract find(id: string): Promise<ImportRecord | undefined>;

  /** The import, its row held until `tx` ends (`FOR UPDATE`). */
  abstract lock(tx: Transaction, id: string): Promise<ImportRecord | undefined>;

  /** Changes the held import. */
  abstract update(
    tx: Transaction,
    id: string,
    change: ImportChange,
  ): Promise<void>;

  /**
   * Up to `limit` imports past their `expiresAt` at `now` whose job is not
   * running (any state but `applying`), oldest first.
   */
  abstract expired(now: Date, limit: number): Promise<ImportRecord[]>;

  /** Removes the import. */
  abstract remove(tx: Transaction, id: string): Promise<void>;

  /** The other imports (by ID) whose upload is `sha256`, read inside `tx`. */
  abstract othersWithUpload(
    tx: Transaction,
    sha256: string,
    except: string,
  ): Promise<string[]>;

  /** Makes `id` the import that removes its upload's bytes once it goes (`upload.created`). */
  abstract takeOverUpload(tx: Transaction, id: string): Promise<void>;
}
