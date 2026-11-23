import type {
  ImportDocument,
  TranslationImport,
} from './translation-import.js';

/** What an apply adds to an import. */
export type AppliedResult = Pick<
  TranslationImport,
  'changeSetId' | 'commit' | 'counts' | 'modules'
>;

/** A stored import with the documents it was made from. */
export interface StoredTranslationImport {
  readonly import: TranslationImport;
  readonly documents: readonly ImportDocument[];
}

/**
 * Port: validated translation imports (#51), kept an hour
 * (`TRANSLATION_IMPORT_TTL_MS`) so the import screen can show the report
 * and then apply it. Not a table: they are kept in the server's memory
 * (`MemoryTranslationImportStore`), bounded, and gone after a restart (the
 * person uploads the file again). An import is only ever found by the one
 * who uploaded it.
 */
export abstract class TranslationImportStore {
  /**
   * Keeps `stored`; false (nothing kept, nothing removed) when the store
   * is full (`MAX_STORED_IMPORTS` imports, or `MAX_STORED_CHARACTERS` of
   * documents, of everyone together).
   */
  abstract add(stored: StoredTranslationImport): Promise<boolean>;

  /** The import `id`, unless it expired; undefined for none. */
  abstract find(id: string): Promise<StoredTranslationImport | undefined>;

  /**
   * Moves the import from `validated` to `applying` (compare-and-swap);
   * undefined when it is not `validated` now (applied, or being applied),
   * or gone.
   */
  abstract claim(id: string): Promise<StoredTranslationImport | undefined>;

  /**
   * Ends an apply that `claim` started: `applied` with `result`, or back
   * to `validated` (without a result) after a failure. Answers the import
   * as kept now (undefined when it is gone).
   */
  abstract settle(
    id: string,
    result: AppliedResult | undefined,
  ): Promise<TranslationImport | undefined>;
}
