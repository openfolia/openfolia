import { Injectable } from '@nestjs/common';
import {
  type AppliedResult,
  type StoredTranslationImport,
  TranslationImportStore,
} from '../core/translation-import-store.js';
import {
  reportTextLength,
  type TranslationImport,
  TRANSLATION_IMPORT_TTL_MS,
} from '../core/translation-import.js';

/** The most imports kept for everyone together: each holds its upload (at most `CCMS_MAX_UPLOAD_BYTES`). */
export const MAX_STORED_IMPORTS = 20;

/** The most characters of documents and report texts kept for everyone together. */
export const MAX_STORED_CHARACTERS = 128 * 1024 * 1024;

/** The characters an import holds: its documents and its report's texts. */
const charactersOf = (stored: StoredTranslationImport) =>
  stored.documents.reduce((n, d) => n + d.xliff.length, 0) +
  reportTextLength(stored.import.modules);

/** The most one person keeps: a fourth upload replaces their oldest one not being applied. */
export const MAX_IMPORTS_PER_ACTOR = 3;

/**
 * `TranslationImportStore` in the server's memory, each import kept an hour
 * from its upload (an applied one an hour from being applied), at most
 * `MAX_STORED_IMPORTS` of them and `MAX_IMPORTS_PER_ACTOR` per person, so
 * one person's uploads never push out another's. Gone after a restart, and
 * not shared between servers: with several servers behind a load balancer,
 * the apply has to reach the server that validated (sticky sessions), or
 * the upload is made again.
 */
@Injectable()
export class MemoryTranslationImportStore extends TranslationImportStore {
  readonly #imports = new Map<string, StoredTranslationImport>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  /** How many imports it holds now, the expired ones left out. */
  get size(): number {
    this.#prune();
    return this.#imports.size;
  }

  add(stored: StoredTranslationImport): Promise<boolean> {
    this.#prune();
    const { createdBy } = stored.import;
    const theirs = [...this.#imports.values()]
      .filter(
        ({ import: i }) =>
          i.createdBy.kind === createdBy.kind &&
          i.createdBy.id === createdBy.id &&
          i.state !== 'applying',
      )
      .sort(
        (a, b) => a.import.createdAt.getTime() - b.import.createdAt.getTime(),
      );
    // Their oldest go to make room for this one, but only once it fits.
    const replaced = theirs.slice(
      0,
      Math.max(0, theirs.length - MAX_IMPORTS_PER_ACTOR + 1),
    );
    const freedCount = replaced.length;
    const freedCharacters = replaced.reduce((n, s) => n + charactersOf(s), 0);
    if (
      this.#imports.size - freedCount >= MAX_STORED_IMPORTS ||
      this.#characters() - freedCharacters + charactersOf(stored) >
        MAX_STORED_CHARACTERS
    ) {
      return Promise.resolve(false);
    }
    for (const old of replaced) this.#imports.delete(old.import.id);
    this.#imports.set(stored.import.id, stored);
    return Promise.resolve(true);
  }

  #characters(): number {
    let total = 0;
    for (const stored of this.#imports.values()) total += charactersOf(stored);
    return total;
  }

  find(id: string): Promise<StoredTranslationImport | undefined> {
    this.#prune();
    return Promise.resolve(this.#imports.get(id));
  }

  claim(id: string): Promise<StoredTranslationImport | undefined> {
    this.#prune();
    const stored = this.#imports.get(id);
    if (stored?.import.state !== 'validated') return Promise.resolve(undefined);
    const claimed = {
      ...stored,
      import: { ...stored.import, state: 'applying' as const },
    };
    this.#imports.set(id, claimed);
    return Promise.resolve(claimed);
  }

  settle(
    id: string,
    result: AppliedResult | undefined,
  ): Promise<TranslationImport | undefined> {
    const stored = this.#imports.get(id);
    if (stored?.import.state !== 'applying') {
      return Promise.resolve(stored?.import);
    }
    const settled: StoredTranslationImport = result
      ? {
          // Applied: the documents are not needed any more.
          documents: [],
          import: {
            ...stored.import,
            ...result,
            state: 'applied',
            expiresAt: new Date(this.now() + TRANSLATION_IMPORT_TTL_MS),
          },
        }
      : { ...stored, import: { ...stored.import, state: 'validated' } };
    this.#imports.set(id, settled);
    this.#prune();
    return Promise.resolve(this.#imports.get(id)?.import);
  }

  #prune(): void {
    const now = this.now();
    for (const [id, { import: i }] of this.#imports) {
      // One being applied stays until its apply ends.
      if (i.state !== 'applying' && i.expiresAt.getTime() <= now) {
        this.#imports.delete(id);
      }
    }
  }
}
