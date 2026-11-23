import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { BlockId } from './ids.js';
import type { Module } from './module.js';
import { sha256Hex } from './sha256.js';
import {
  translatableUnits,
  type TranslatableUnit,
} from './translatable-units.js';

export * from './translatable-units.js';

/** A unit's source hash: 64 lowercase hex characters (SHA-256). */
export const SourceHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, '64 lowercase hex characters (SHA-256)');
export type SourceHash = z.infer<typeof SourceHash>;

/**
 * A stable hash of a unit's own translatable text: its parts (which field,
 * the inline content with its marks, attribute references, cross-references
 * and keys) as canonical JSON, hashed with SHA-256. Neither the block's ID
 * nor its type, nor any nested block, takes part. The parts of
 * `translatableUnits` are normalized, so a difference the canonical printer
 * removes (mark order, text runs split differently) gives the same hash.
 */
export function sourceHash(unit: Pick<TranslatableUnit, 'parts'>): SourceHash {
  return sha256Hex(canonicalJson(unit.parts));
}

/** JSON with every object's keys sorted, so equal values print alike. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // Text in NFC, so the same text typed or pasted decomposed hashes alike.
  return JSON.stringify(
    typeof value === 'string' ? value.normalize('NFC') : value,
  );
}

/** Per module object: its units' hashes, worked out once (parsed modules are cached and shared). */
const hashesOf = new WeakMap<Module, ReadonlyMap<string, SourceHash>>();

/**
 * The source hash of each translatable unit of `module`, by block ID, in
 * document order. Kept per module object, so a module compared with many
 * translations is hashed once: by object identity, so the module must not
 * be changed in place afterwards.
 */
export function sourceHashes(module: Module): ReadonlyMap<string, SourceHash> {
  let found = hashesOf.get(module);
  if (!found) {
    found = new Map(
      translatableUnits(module).map((unit) => [unit.blockId, sourceHash(unit)]),
    );
    hashesOf.set(module, found);
  }
  return found;
}

/**
 * Bumped on breaking changes to the translation record's format, and to
 * what `sourceHash` hashes (a record of an older version then counts as
 * outdated, or is migrated).
 */
export const CURRENT_TRANSLATION_RECORD_VERSION = 1;

/** A Git commit ID in full: SHA-1 (40) or SHA-256 (64 hex characters). */
export const CommitId = z
  .string()
  .regex(
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    'a full commit ID in lowercase hex',
  );

/**
 * What a translated module (one target-language file) was translated
 * from: per block ID the source hash of the source block it was made from,
 * and the source commit that was read. Stored next to the translated
 * module (`modules/<lang>/<id>.translation.yaml`); written by the import.
 */
export const TranslationRecord = z.object({
  schemaVersion: z.literal(CURRENT_TRANSLATION_RECORD_VERSION),
  sourceCommit: CommitId,
  // `__proto__` cannot be an object key safely: a block of that ID is never
  // recorded (so it always counts as outdated).
  blocks: z.record(
    BlockId.refine((id) => id !== '__proto__', 'no block "__proto__"'),
    SourceHash,
  ),
});
export type TranslationRecord = z.infer<typeof TranslationRecord>;

export class TranslationRecordParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationRecordParseError';
  }
}

/** Reads a translation record from its YAML file. */
export function parseTranslationRecord(source: string): TranslationRecord {
  let data: unknown;
  try {
    data = parseYaml(source);
  } catch (e) {
    throw new TranslationRecordParseError(
      `invalid YAML: ${(e as Error).message}`,
    );
  }
  const blocks = (data as { blocks?: unknown } | null)?.blocks;
  if (
    typeof blocks === 'object' &&
    blocks &&
    Object.hasOwn(blocks, '__proto__')
  ) {
    throw new TranslationRecordParseError(
      'invalid translation record: blocks: no block "__proto__"',
    );
  }
  const result = TranslationRecord.safeParse(data);
  if (!result.success) {
    throw new TranslationRecordParseError(
      `invalid translation record: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

/** Prints a translation record as canonical YAML: fixed key order, blocks sorted by ID. */
export function printTranslationRecord(record: TranslationRecord): string {
  const blocks = Object.fromEntries(
    Object.keys(record.blocks)
      .sort()
      .map((id) => [id, record.blocks[id]]),
  );
  return stringify(
    {
      schemaVersion: CURRENT_TRANSLATION_RECORD_VERSION,
      sourceCommit: record.sourceCommit,
      blocks,
    },
    { lineWidth: 0 },
  );
}

/** The record of a translation made from `source` (the source-language module) at `sourceCommit`. */
export function translationRecordOf(
  source: Module,
  sourceCommit: string,
): TranslationRecord {
  return {
    schemaVersion: CURRENT_TRANSLATION_RECORD_VERSION,
    sourceCommit,
    blocks: Object.fromEntries(
      [...sourceHashes(source)].filter(([id]) => id !== '__proto__'),
    ),
  };
}

/** Whether a source block's translation was made from its current text. */
export type BlockTranslation = 'up-to-date' | 'outdated';

/**
 * Each unit of `source` (the source-language module, in document order)
 * compared with what its translation was made from: `up-to-date` when
 * `record` names the block with the hash its text has now, else
 * `outdated` (changed since, or not translated yet). Without a record (a
 * translation made before tracking) every block is outdated. Blocks the
 * record names that the source no longer has are not listed.
 */
export function compareWithRecord(
  source: Module,
  record: TranslationRecord | undefined,
): { readonly blockId: string; readonly state: BlockTranslation }[] {
  return [...sourceHashes(source)].map(([blockId, hash]) => ({
    blockId,
    state:
      record !== undefined &&
      Object.hasOwn(record.blocks, blockId) &&
      record.blocks[blockId] === hash
        ? 'up-to-date'
        : 'outdated',
  }));
}
