import type { z } from 'zod';
import type { Block, Item } from '../blocks.js';
import type { ProjectConfig } from '../config.js';
import type { Inline } from '../inline.js';
import type { Manifest, ManifestEntry } from '../manifest.js';
import { Module } from '../module.js';
import {
  validateManifest,
  validateModule,
  type Issue,
  type IssueCode,
} from '../validate.js';
import { TABLE_TOO_LARGE } from '../table-limits.js';
import { walk } from '../walk.js';
import {
  CURRENT_IMPORT_FORMAT_VERSION,
  IMPORT_ASSETS_FOLDER,
  IMPORT_DOCUMENT_PATH,
  IMPORT_FORMAT_MIGRATIONS,
  ImportedManifest,
  ImportFrame,
  type ConverterReportEntry,
  type ImportSource,
} from './format.js';
import {
  blockPointers,
  droppedMembers,
  entryPointers,
  jsonPointer,
} from './pointer.js';

/**
 * An import archive, unpacked: every file by its path inside the archive
 * (`import.json`, `assets/<sha256>`), as bytes. Reading the archive, and
 * its size, file count and path limits, is the caller's; directory entries
 * (a path ending in `/`) are ignored.
 */
export interface ImportBundle {
  readonly files: ReadonlyMap<string, Uint8Array>;
}

/** What already exists where the bundle would be imported. A `Set` is one. */
export interface ExistingIds {
  has(id: string): boolean | Promise<boolean>;
}

export interface ImportValidationOptions {
  readonly existing?: {
    /** Module IDs already in the repository (any language). */
    readonly modules?: ExistingIds;
    /** Manual (manifest) IDs already in the repository. */
    readonly manuals?: ExistingIds;
    /** Files already stored, as `sha256:<hash>`, so a bundle may refer to them without carrying them. */
    readonly assets?: ExistingIds;
  };
  /** The deepest nesting of arrays and objects `import.json` may have; default `DEFAULT_IMPORT_MAX_DEPTH`, at most `MAX_IMPORT_MAX_DEPTH`. */
  readonly maxDepth?: number;
  /**
   * The most distinct IDs looked up in `existing` (each lookup is awaited
   * one after the other); default `DEFAULT_IMPORT_MAX_LOOKUPS`. Past it the
   * bundle gets a `too-many-references` error.
   */
  readonly maxLookups?: number;
  /**
   * The largest `import.json`, in bytes, refused before it is decoded or
   * parsed (`document-too-large`); default `DEFAULT_IMPORT_MAX_DOCUMENT_BYTES`.
   */
  readonly maxDocumentBytes?: number;
  /**
   * The most modules and manuals together, refused before any is checked
   * (`too-many-items`); default `DEFAULT_IMPORT_MAX_ITEMS`.
   */
  readonly maxItems?: number;
  /**
   * The most values (array elements and object members, at any depth) in
   * `import.json`, counted before any is checked (`too-many-values`);
   * default `DEFAULT_IMPORT_MAX_VALUES`. One module or manual may hold at
   * most `MAX_ITEM_VALUES` (`item-too-large`), and the converter's report
   * at most `MAX_REPORT_ENTRIES` entries (`report-too-large`). These bound
   * the work, and the findings, a small upload can cause.
   */
  readonly maxValues?: number;
}

/** The deepest nesting of arrays and objects in `import.json` a validation reads by default. */
export const DEFAULT_IMPORT_MAX_DEPTH = 128;
/** The deepest nesting a caller may allow: deeper would risk the stack while parsing. */
export const MAX_IMPORT_MAX_DEPTH = 256;
/** The most distinct IDs looked up in `existing` by default. */
export const DEFAULT_IMPORT_MAX_LOOKUPS = 10_000;
/** The largest `import.json` a validation reads by default (64 MiB). */
export const DEFAULT_IMPORT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
/** The most modules and manuals together a validation checks by default. */
export const DEFAULT_IMPORT_MAX_ITEMS = 10_000;
/** The most values in `import.json` a validation reads by default. */
export const DEFAULT_IMPORT_MAX_VALUES = 1_000_000;
/** The most values one module or manual may hold (more than a working copy's 512 KiB of real content needs). */
export const MAX_ITEM_VALUES = 50_000;
/**
 * The most values, in all, of the modules and manuals whose schema check
 * failed: a malformed value costs far more to report than to read, so past
 * this the rest are not checked (`not-checked`).
 */
export const MAX_INVALID_VALUES = 100_000;
/** The most entries the converter's report may hold. */
export const MAX_REPORT_ENTRIES = 10_000;
/** The most findings kept per module or manual, and for the bundle; the rest are counted in one more. */
export const MAX_KEPT_ISSUES = 100;

export type ImportIssueCode =
  | IssueCode
  | 'missing-import-document'
  | 'invalid-json'
  | 'too-deep'
  | 'invalid-format-version'
  | 'unsupported-format-version'
  | 'invalid-schema'
  /** A table past `MAX_TABLE_COLUMNS` or `MAX_TABLE_CELLS` (#686). */
  | 'table-too-large'
  | 'unknown-field'
  | 'duplicate-module'
  | 'duplicate-manual'
  | 'dangling-module-reference'
  | 'dangling-block-reference'
  | 'missing-asset'
  | 'asset-hash-mismatch'
  | 'attachment-size-mismatch'
  | 'unused-asset'
  | 'invalid-asset-name'
  | 'unexpected-file'
  | 'too-many-references'
  | 'document-too-large'
  | 'too-many-items'
  | 'too-many-values'
  | 'item-too-large'
  | 'not-checked'
  | 'report-too-large'
  | 'id-clash';

export interface ImportIssue {
  /** `error` stops the import; `warning` is worth a look; `info` is for the import to decide (an ID clash). */
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: ImportIssueCode;
  readonly message: string;
  /** Where in `import.json` (a JSON Pointer from its root), when the issue is about a place in it. */
  readonly pointer?: string;
  /** The block, list item or step the issue is about, by its ID. */
  readonly at?: string;
}

interface ItemBase {
  /** Where the item is in `import.json` (modules and manuals) or the archive (assets). */
  readonly pointer: string;
  readonly issues: ImportIssue[];
}

export interface ImportModuleItem extends ItemBase {
  readonly kind: 'module';
  /** The module's ID; for one that didn't parse, what it says, or `#<index>`. */
  readonly id: string;
  readonly lang?: string;
  /** `meta.source.id`: the item's ID in the source system. */
  readonly sourceId?: string;
  /** A module with this ID already exists (an `id-clash` issue says so too). */
  exists: boolean;
  /** The number of `passthrough` blocks, content kept verbatim. */
  readonly passthrough: number;
  /** The parsed module, when it parsed. */
  readonly module?: Module;
}

export interface ImportManualItem extends ItemBase {
  readonly kind: 'manual';
  readonly id: string;
  /** A manual with this ID already exists (an `id-clash` issue says so too). */
  exists: boolean;
  /** The parsed manifest, when it parsed. */
  readonly manifest?: Manifest;
}

export interface ImportAssetItem extends ItemBase {
  readonly kind: 'asset';
  /** `sha256:<hash>`, from the file's name. */
  readonly id: string;
  /** The file's size in bytes. */
  readonly size: number;
  /** Whether a module refers to it. */
  readonly used: boolean;
}

export type ImportItem = ImportModuleItem | ImportManualItem | ImportAssetItem;

export interface ImportValidation {
  /** No error anywhere: neither in `issues` nor in an item. */
  readonly valid: boolean;
  /** The bundle's format version, as it says. */
  readonly formatVersion?: number;
  readonly source?: ImportSource;
  /** Issues with the bundle as a whole (`import.json` itself, its frame, stray files). */
  readonly issues: ImportIssue[];
  /** Modules and manuals in document order, then the files under `assets/` by name. */
  readonly items: ImportItem[];
  /** The converter's own report, passed through. */
  readonly report: ConverterReportEntry[];
  readonly counts: {
    readonly modules: number;
    readonly manuals: number;
    readonly assets: number;
    readonly passthrough: number;
    readonly clashes: number;
    readonly errors: number;
    readonly warnings: number;
  };
}

const ASSET_NAME = /^[a-f0-9]{64}$/;

/**
 * Checks an import bundle before anything is imported, against the target
 * repository's configuration and, through `options.existing`, what is
 * already there: the schema (with JSON Pointers), the content model's own
 * validation, references inside the bundle, the files and their hashes.
 * ID clashes are reported (`info`), not refused: the import decides. Never
 * throws for anything a bundle holds; a failing `existing` lookup (the
 * caller's infrastructure) rejects the promise.
 */
export async function validateImport(
  bundle: ImportBundle,
  config: ProjectConfig,
  options: ImportValidationOptions = {},
): Promise<ImportValidation> {
  const existing = options.existing ?? {};
  const issues: ImportIssue[] = [];
  const items: ImportItem[] = [];
  const result = (
    extra: { formatVersion?: number; source?: ImportSource } = {},
    report: ConverterReportEntry[] = [],
  ): ImportValidation => summarize(issues, items, report, extra);

  const document = readDocument(
    bundle,
    limit(options.maxDepth, DEFAULT_IMPORT_MAX_DEPTH, MAX_IMPORT_MAX_DEPTH),
    limit(
      options.maxDocumentBytes,
      DEFAULT_IMPORT_MAX_DOCUMENT_BYTES,
      Number.MAX_SAFE_INTEGER,
    ),
    limit(
      options.maxValues,
      DEFAULT_IMPORT_MAX_VALUES,
      Number.MAX_SAFE_INTEGER,
    ),
    issues,
  );
  if (document === undefined) return result();

  const version = document['formatVersion'];
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    issues.push({
      severity: 'error',
      code: 'invalid-format-version',
      message: `"formatVersion" must be a whole number from 1 (this validator reads up to ${CURRENT_IMPORT_FORMAT_VERSION})`,
      pointer: '/formatVersion',
    });
    return result();
  }
  if (version > CURRENT_IMPORT_FORMAT_VERSION) {
    issues.push({
      severity: 'error',
      code: 'unsupported-format-version',
      message: `the bundle is in import format version ${version}, newer than the ${CURRENT_IMPORT_FORMAT_VERSION} this validator reads; validate it with a newer version, or have the converter write version ${CURRENT_IMPORT_FORMAT_VERSION}`,
      pointer: '/formatVersion',
    });
    return result({ formatVersion: version });
  }
  const current = migrate(document, version, issues);
  if (current === undefined) return result({ formatVersion: version });

  const rawReport = current['report'];
  if (Array.isArray(rawReport) && rawReport.length > MAX_REPORT_ENTRIES) {
    issues.push({
      severity: 'error',
      code: 'report-too-large',
      message: `the converter's report holds ${rawReport.length} entries; at most ${MAX_REPORT_ENTRIES} are read`,
      pointer: '/report',
    });
    return result({ formatVersion: version });
  }
  const frame = ImportFrame.safeParse(current);
  if (!frame.success) appendAll(issues, kept(schemaIssues(frame.error, '')));
  const source = frame.success ? frame.data.source : undefined;
  const report = frame.success ? frame.data.report : [];
  const rawModules = Array.isArray(current['modules'])
    ? current['modules']
    : [];
  const rawManuals = Array.isArray(current['manuals'])
    ? current['manuals']
    : [];
  const maxItems = limit(
    options.maxItems,
    DEFAULT_IMPORT_MAX_ITEMS,
    Number.MAX_SAFE_INTEGER,
  );
  if (rawModules.length + rawManuals.length > maxItems) {
    issues.push({
      severity: 'error',
      code: 'too-many-items',
      message: `the bundle holds ${rawModules.length} modules and ${rawManuals.length} manuals; at most ${maxItems} together are checked`,
    });
    return result({ formatVersion: version, ...(source && { source }) });
  }

  // Modules, one at a time, so one broken module doesn't hide the rest.
  const budget = { invalid: MAX_INVALID_VALUES };
  const moduleItems = rawModules.map((raw, i) =>
    checkModule(raw, `/modules/${i}`, i, config, budget),
  );
  const manualItems = rawManuals.map((raw, i) =>
    checkManual(raw, `/manuals/${i}`, i, config, budget),
  );

  // What the bundle holds, for references and duplicates.
  const bundleBlocks = new Map<string, Set<string>>();
  const seenModules = new Set<string>();
  for (const item of moduleItems) {
    if (!item.module) continue;
    const { id, meta } = item.module;
    const key = `${meta.lang}\u0000${id}`;
    if (seenModules.has(key))
      item.issues.push({
        severity: 'error',
        code: 'duplicate-module',
        message: `module "${id}" in "${meta.lang}" is in the bundle more than once`,
        pointer: item.pointer,
      });
    seenModules.add(key);
    const blocks = bundleBlocks.get(id) ?? new Set<string>();
    for (const { node } of walk(item.module.blocks)) blocks.add(node.id);
    bundleBlocks.set(id, blocks);
  }
  const seenManuals = new Set<string>();
  for (const item of manualItems) {
    if (!item.manifest) continue;
    if (seenManuals.has(item.id))
      item.issues.push({
        severity: 'error',
        code: 'duplicate-manual',
        message: `manual "${item.id}" is in the bundle more than once`,
        pointer: item.pointer,
      });
    seenManuals.add(item.id);
  }

  const lookups = new Map<string, Promise<boolean>>();
  const maxLookups = limit(
    options.maxLookups,
    DEFAULT_IMPORT_MAX_LOOKUPS,
    1_000_000,
  );
  let lookupsCapped = false;
  let referenceLookups = 0;
  /**
   * Whether `id` is in `lookup`, each ID looked up once. References (what
   * the bundle names) count against `maxLookups`; the bundle's own IDs,
   * looked up for clashes, are bounded by its size and don't.
   */
  const exists = (
    lookup: ExistingIds | undefined,
    kind: string,
    id: string,
    reference = true,
  ): Promise<boolean> => {
    const key = `${kind}\u0000${id}`;
    let found = lookups.get(key);
    if (!found) {
      if (!lookup) return Promise.resolve(false);
      if (reference && referenceLookups >= maxLookups) {
        // The bundle names more distinct IDs than may be looked up: said once,
        // and the rest counted as found, so they don't flood the report.
        if (!lookupsCapped)
          issues.push({
            severity: 'error',
            code: 'too-many-references',
            message: `the bundle's references name more than ${maxLookups} distinct modules and files outside it`,
          });
        lookupsCapped = true;
        return Promise.resolve(true);
      }
      if (reference) referenceLookups++;
      found = Promise.resolve(lookup.has(id)).then(Boolean);
      lookups.set(key, found);
    }
    return found;
  };
  // Modules in the bundle that didn't parse still count as there, so what
  // refers to them isn't reported as dangling as well (their own errors say enough).
  const unreadable = new Set(
    moduleItems.filter((i) => !i.module).map((i) => i.id),
  );
  const moduleExists = (id: string) =>
    bundleBlocks.has(id) || unreadable.has(id)
      ? Promise.resolve(true)
      : exists(existing.modules, 'module', id);

  const assetFiles = new Map<string, Uint8Array>();
  for (const [path, bytes] of bundle.files) {
    if (path === IMPORT_DOCUMENT_PATH || path.endsWith('/')) continue;
    const name = path.startsWith(IMPORT_ASSETS_FOLDER)
      ? path.slice(IMPORT_ASSETS_FOLDER.length)
      : undefined;
    if (name !== undefined && ASSET_NAME.test(name)) {
      assetFiles.set(name, bytes);
    } else if (name !== undefined) {
      issues.push({
        severity: 'warning',
        code: 'invalid-asset-name',
        message: `the file ${quotePath(path)} is not named by its SHA-256 (64 lowercase hex characters) and is ignored`,
      });
    } else {
      issues.push({
        severity: 'warning',
        code: 'unexpected-file',
        message: `the file ${quotePath(path)} is neither ${IMPORT_DOCUMENT_PATH} nor under ${IMPORT_ASSETS_FOLDER} and is ignored`,
      });
    }
  }
  const usedAssets = new Set<string>();

  for (const item of moduleItems) {
    const { module } = item;
    if (!module) continue;
    if (await exists(existing.modules, 'module', module.id, false)) {
      item.exists = true;
      item.issues.push(clash('module', module.id, item.pointer));
    }
    const pointers = blockPointers(module.blocks);
    const at = (id: string) => item.pointer + (pointers.get(id) ?? '');
    for (const { kind, node } of walk(module.blocks)) {
      for (const inline of inlinesOf(node, kind)) {
        if (inline.type !== 'xref') continue;
        await checkTarget(
          item,
          inline.module,
          inline.block,
          node.id,
          at(node.id),
        );
      }
      if (kind !== 'block') continue;
      if (node.type === 'moduleRef')
        await checkTarget(
          item,
          node.module,
          node.block,
          node.id,
          `${at(node.id)}/module`,
        );
      if (node.type === 'image' || node.type === 'attachment') {
        const hash = node.asset.slice('sha256:'.length);
        const file = assetFiles.get(hash);
        if (file) {
          usedAssets.add(hash);
          if (node.type === 'attachment' && node.size !== file.length)
            item.issues.push({
              severity: 'warning',
              code: 'attachment-size-mismatch',
              message: `the attachment says ${node.size} bytes, the file has ${file.length}; the file's size is kept`,
              pointer: `${at(node.id)}/size`,
              at: node.id,
            });
        } else if (!(await exists(existing.assets, 'asset', node.asset))) {
          item.issues.push({
            severity: 'error',
            code: 'missing-asset',
            message: `${node.asset} is neither in the bundle (${IMPORT_ASSETS_FOLDER}${hash}) nor stored already`,
            pointer: `${at(node.id)}/asset`,
            at: node.id,
          });
        }
      }
    }
  }

  for (const item of manualItems) {
    const { manifest } = item;
    if (!manifest) continue;
    if (await exists(existing.manuals, 'manual', manifest.id, false)) {
      item.exists = true;
      item.issues.push(clash('manual', manifest.id, item.pointer));
    }
    const checkEntries = async (
      entries: readonly ManifestEntry[],
      at: string,
    ) => {
      for (const [i, entry] of entries.entries()) {
        if ('entries' in entry) {
          await checkEntries(entry.entries, `${at}/${i}/entries`);
        } else if (!(await moduleExists(entry.module))) {
          item.issues.push({
            severity: 'error',
            code: 'dangling-module-reference',
            message: `module "${entry.module}" is neither in the bundle nor in the repository`,
            pointer: `${at}/${i}/module`,
          });
        }
      }
    };
    await checkEntries(manifest.entries, `${item.pointer}/entries`);
  }

  const assetItems: ImportAssetItem[] = [];
  for (const name of [...assetFiles.keys()].sort()) {
    const bytes = assetFiles.get(name) as Uint8Array;
    const path = IMPORT_ASSETS_FOLDER + name;
    const itemIssues: ImportIssue[] = [];
    const actual = await sha256OfBytes(bytes);
    if (actual !== name)
      itemIssues.push({
        severity: 'error',
        code: 'asset-hash-mismatch',
        message: `the file's SHA-256 is ${actual}, not the ${name} it is named by`,
      });
    const used = usedAssets.has(name);
    if (!used)
      itemIssues.push({
        severity: 'warning',
        code: 'unused-asset',
        message: 'no module refers to this file; it is not imported',
      });
    assetItems.push({
      kind: 'asset',
      id: `sha256:${name}`,
      pointer: path,
      size: bytes.length,
      used,
      issues: itemIssues,
    });
  }

  for (const list of [moduleItems, manualItems, assetItems])
    appendAll<ImportItem>(items, list);
  return result({ formatVersion: version, source }, report);

  async function checkTarget(
    item: ImportModuleItem,
    module: string,
    block: string | undefined,
    from: string,
    pointer: string,
  ): Promise<void> {
    if (!(await moduleExists(module))) {
      item.issues.push({
        severity: 'error',
        code: 'dangling-module-reference',
        message: `module "${module}" is neither in the bundle nor in the repository`,
        pointer,
        at: from,
      });
      return;
    }
    // Blocks are checked only in modules the bundle holds.
    const blocks = bundleBlocks.get(module);
    if (block !== undefined && blocks && !blocks.has(block))
      item.issues.push({
        severity: 'error',
        code: 'dangling-block-reference',
        message: `module "${module}" has no block "${block}"`,
        pointer,
        at: from,
      });
  }
}

/** `import.json` read as a JSON object, or `undefined` with the issue said. */
function readDocument(
  bundle: ImportBundle,
  maxDepth: number,
  maxBytes: number,
  maxValues: number,
  issues: ImportIssue[],
): Record<string, unknown> | undefined {
  const bytes = bundle.files.get(IMPORT_DOCUMENT_PATH);
  if (!bytes) {
    issues.push({
      severity: 'error',
      code: 'missing-import-document',
      message: `the bundle has no ${IMPORT_DOCUMENT_PATH} at its root`,
    });
    return undefined;
  }
  if (bytes.byteLength > maxBytes) {
    issues.push({
      severity: 'error',
      code: 'document-too-large',
      message: `${IMPORT_DOCUMENT_PATH} holds ${bytes.byteLength} bytes; at most ${maxBytes} are read`,
    });
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'invalid-json',
      message: `${IMPORT_DOCUMENT_PATH} is not JSON in UTF-8: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
  const shape = measure(value, maxDepth, maxValues);
  if (shape === 'too-deep') {
    issues.push({
      severity: 'error',
      code: 'too-deep',
      message: `${IMPORT_DOCUMENT_PATH} nests arrays and objects deeper than ${maxDepth} levels`,
    });
    return undefined;
  }
  if (shape === 'too-many-values') {
    issues.push({
      severity: 'error',
      code: 'too-many-values',
      message: `${IMPORT_DOCUMENT_PATH} holds more than ${maxValues} values (array elements and object members)`,
    });
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({
      severity: 'error',
      code: 'invalid-schema',
      message: `${IMPORT_DOCUMENT_PATH} must hold a JSON object`,
      pointer: '',
    });
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Whether `value` nests arrays and objects deeper than `maxDepth`, or holds
 * more than `maxValues` values (array elements and object members) at any
 * depth; found without recursion, stopping at the first limit passed.
 */
function measure(
  value: unknown,
  maxDepth: number,
  maxValues: number,
): 'too-deep' | 'too-many-values' | undefined {
  const stack: [unknown, number][] = [[value, 0]];
  let values = 0;
  while (stack.length > 0) {
    const [next, depth] = stack.pop() as [unknown, number];
    if (typeof next !== 'object' || next === null) continue;
    if (depth + 1 > maxDepth) return 'too-deep';
    const children = Object.values(next);
    values += children.length;
    if (values > maxValues) return 'too-many-values';
    for (const child of children) stack.push([child, depth + 1]);
  }
  return undefined;
}

/** Whether `value` holds more than `max` values at any depth. */
function holdsMoreThan(value: unknown, max: number): boolean {
  return measure(value, Number.MAX_SAFE_INTEGER, max) === 'too-many-values';
}

/** What schema checks may still fail: the values left of `MAX_INVALID_VALUES`. */
interface SchemaBudget {
  invalid: number;
}

/**
 * Whether `raw` may be schema-checked, and if not the one finding it gets
 * instead: too large, or the bundle's budget of malformed values spent.
 */
function uncheckable(
  raw: unknown,
  pointer: string,
  budget: SchemaBudget,
): ImportIssue | undefined {
  if (budget.invalid <= 0) {
    return {
      severity: 'error',
      code: 'not-checked',
      message: `the bundle's malformed modules and manuals before it hold more than ${MAX_INVALID_VALUES} values; not checked`,
      pointer,
    };
  }
  if (holdsMoreThan(raw, MAX_ITEM_VALUES)) {
    return {
      severity: 'error',
      code: 'item-too-large',
      message: `it holds more than ${MAX_ITEM_VALUES} values; not checked`,
      pointer,
    };
  }
  return undefined;
}

/** Spends what a failed schema check of `raw` cost from `budget`. */
function spend(raw: unknown, budget: SchemaBudget): void {
  let values = 0;
  const stack: unknown[] = [raw];
  while (stack.length > 0 && values <= MAX_ITEM_VALUES) {
    const next = stack.pop();
    if (typeof next !== 'object' || next === null) continue;
    const children = Object.values(next);
    values += children.length;
    for (const child of children) stack.push(child);
  }
  budget.invalid -= Math.max(1, values);
}

/** At most `MAX_KEPT_ISSUES` of `found`, the rest counted in one more. */
function kept(found: ImportIssue[], pointer?: string): ImportIssue[] {
  if (found.length <= MAX_KEPT_ISSUES) return found;
  const first = found[0];
  return [
    ...found.slice(0, MAX_KEPT_ISSUES),
    {
      severity: first?.severity ?? 'error',
      code: first?.code ?? 'invalid-schema',
      message: `and ${found.length - MAX_KEPT_ISSUES} more like these`,
      ...(pointer !== undefined && { pointer }),
    },
  ];
}

/** The document migrated to the current format version, or `undefined` with the issue said. */
function migrate(
  document: Record<string, unknown>,
  version: number,
  issues: ImportIssue[],
): Record<string, unknown> | undefined {
  let current = document;
  for (let v = version; v < CURRENT_IMPORT_FORMAT_VERSION; v++) {
    const step = IMPORT_FORMAT_MIGRATIONS.get(v);
    if (!step) {
      issues.push({
        severity: 'error',
        code: 'invalid-format-version',
        message: `import format version ${v} is not one this validator knows`,
        pointer: '/formatVersion',
      });
      return undefined;
    }
    try {
      current = step(current);
    } catch (error) {
      issues.push({
        severity: 'error',
        code: 'invalid-format-version',
        message: `the bundle could not be migrated from import format version ${v}: ${error instanceof Error ? error.message : String(error)}`,
        pointer: '/formatVersion',
      });
      return undefined;
    }
  }
  if (
    typeof current !== 'object' ||
    current === null ||
    Array.isArray(current)
  ) {
    issues.push({
      severity: 'error',
      code: 'invalid-format-version',
      message: `the bundle could not be migrated from import format version ${version}`,
      pointer: '/formatVersion',
    });
    return undefined;
  }
  // A migration that left the document's version behind would pass the frame unnoticed.
  return { ...current, formatVersion: CURRENT_IMPORT_FORMAT_VERSION };
}

function checkModule(
  raw: unknown,
  pointer: string,
  index: number,
  config: ProjectConfig,
  budget: SchemaBudget,
): ImportModuleItem {
  const refused = uncheckable(raw, pointer, budget);
  const parsed = refused ? undefined : Module.safeParse(raw);
  if (parsed && !parsed.success) spend(raw, budget);
  if (!parsed?.success) {
    const fallback = raw as { id?: unknown; meta?: { lang?: unknown } } | null;
    return {
      kind: 'module',
      id:
        typeof fallback?.id === 'string' ? safeText(fallback.id) : `#${index}`,
      ...(typeof fallback?.meta?.lang === 'string'
        ? { lang: safeText(fallback.meta.lang) }
        : {}),
      pointer,
      exists: false,
      passthrough: 0,
      issues: parsed
        ? kept(schemaIssues(parsed.error, pointer), pointer)
        : refused
          ? [refused]
          : [],
    };
  }
  const module = parsed.data;
  const pointers = blockPointers(module.blocks);
  const issues: ImportIssue[] = kept(
    [
      ...unknownFields(raw, module, pointer),
      ...validateModule(module, config).map((issue) =>
        fromModelIssue(issue, pointer + modulePointer(issue, pointers)),
      ),
    ],
    pointer,
  );
  let passthrough = 0;
  for (const { kind, node } of walk(module.blocks))
    if (kind === 'block' && node.type === 'passthrough') passthrough++;
  return {
    kind: 'module',
    id: module.id,
    lang: module.meta.lang,
    ...(module.meta.source ? { sourceId: module.meta.source.id } : {}),
    pointer,
    exists: false,
    passthrough,
    module,
    issues,
  };
}

function checkManual(
  raw: unknown,
  pointer: string,
  index: number,
  config: ProjectConfig,
  budget: SchemaBudget,
): ImportManualItem {
  const refused = uncheckable(raw, pointer, budget);
  const parsed = refused ? undefined : ImportedManifest.safeParse(raw);
  if (parsed && !parsed.success) spend(raw, budget);
  if (!parsed?.success) {
    const id = (raw as { id?: unknown } | null)?.id;
    return {
      kind: 'manual',
      id: typeof id === 'string' ? safeText(id) : `#${index}`,
      pointer,
      exists: false,
      issues: parsed
        ? kept(schemaIssues(parsed.error, pointer), pointer)
        : refused
          ? [refused]
          : [],
    };
  }
  const manifest = parsed.data;
  let entries: Map<string, string> | undefined;
  const entryAt = () =>
    (entries ??= entryPointers(manifest.entries, config.languages.source));
  return {
    kind: 'manual',
    id: manifest.id,
    pointer,
    exists: false,
    manifest,
    issues: kept(
      [
        ...unknownFields(raw, manifest, pointer),
        ...validateManifest(manifest, config).map((issue) =>
          fromModelIssue(
            issue,
            pointer + manifestPointer(issue, manifest, entryAt),
          ),
        ),
      ],
      pointer,
    ),
  };
}

/** Where in a module (relative to it) a `validateModule` issue points. */
function modulePointer(issue: Issue, blocks: Map<string, string>): string {
  if (issue.at !== undefined) return blocks.get(issue.at) ?? '';
  switch (issue.code) {
    case 'unknown-module-type':
      return '/meta/type';
    case 'unknown-audience':
      return '/meta/audience';
    case 'unknown-language':
      return '/meta/lang';
    case 'unknown-facet':
    case 'unknown-facet-value':
      return '/meta/facets';
    default:
      return '';
  }
}

/** Where in a manifest (relative to it) a `validateManifest` issue points. */
function manifestPointer(
  issue: Issue,
  manifest: Manifest,
  entryAt: () => Map<string, string>,
): string {
  const { at } = issue;
  if (at === undefined)
    return issue.code === 'unknown-audience'
      ? '/audience'
      : issue.code === 'inconsistent-variants'
        ? '/variants'
        : '';
  const variant = /^variant (\d+)$/.exec(at);
  if (variant) return `/variants/${Number(variant[1]) - 1}`;
  if (Object.hasOwn(manifest.attributes, at))
    return '/attributes' + jsonPointer([at]);
  return entryAt().get(at) ?? '';
}

function fromModelIssue(issue: Issue, pointer: string): ImportIssue {
  return {
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    pointer,
    ...(issue.at !== undefined ? { at: issue.at } : {}),
  };
}

function schemaIssues(error: z.ZodError, base: string): ImportIssue[] {
  return error.issues.flatMap((issue): ImportIssue[] =>
    // A member a strict object doesn't have: one issue per member, pointing at it.
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({
          severity: 'error',
          code: 'invalid-schema',
          message: 'not a field of the format',
          pointer: base + jsonPointer([...issue.path, key]),
        }))
      : [
          {
            severity: 'error',
            // A table past the caps (#686): the schema's issue names its own code.
            code:
              issue.code === 'custom' &&
              issue.params?.['code'] === TABLE_TOO_LARGE
                ? TABLE_TOO_LARGE
                : 'invalid-schema',
            message: issue.message,
            pointer: base + jsonPointer(issue.path),
          },
        ],
  );
}

function unknownFields(
  raw: unknown,
  parsed: unknown,
  base: string,
): ImportIssue[] {
  return droppedMembers(raw, parsed).map((pointer) => ({
    severity: 'warning',
    code: 'unknown-field',
    message: 'not a field of the format; it is ignored',
    pointer: base + pointer,
  }));
}

function clash(
  kind: 'module' | 'manual',
  id: string,
  pointer: string,
): ImportIssue {
  return {
    severity: 'info',
    code: 'id-clash',
    message: `a ${kind} "${id}" already exists; the import decides whether to update it`,
    pointer: `${pointer}/id`,
  };
}

/** The inline content a block or item holds itself (not its nested blocks'). */
function inlinesOf(node: Block | Item, kind: 'block' | 'item'): Inline[] {
  if (kind === 'item') return (node as Item).content;
  const block = node as Block;
  switch (block.type) {
    case 'paragraph':
      return block.content;
    case 'section':
      return block.title;
    case 'procedure':
    case 'table':
    case 'image':
      return block.title ?? [];
    case 'safety':
      return block.hazard;
    case 'faq':
      return block.question;
    default:
      return [];
  }
}

/** A path from the archive, quoted and cut, so a hostile name can't pass for anything else. */
function quotePath(path: string): string {
  return JSON.stringify(safeText(path));
}

/**
 * Text from the bundle as it may appear in a report: control, format
 * (direction marks, zero-width) and line separator characters as `\u` escapes,
 * cut to `max` characters, so a hostile name can't pass for something else.
 */
function safeText(text: string, max = 200): string {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return cut.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u${(c.codePointAt(0) as number).toString(16).padStart(4, '0')}`,
  );
}

/** Pushes every item of `from` to `to`, without spreading it into arguments (no limit on its length). */
function appendAll<T>(to: T[], from: readonly T[]): void {
  for (const item of from) to.push(item);
}

/** A caller's limit, as a whole number from 1 to `max`; `fallback` when it is none. */
function limit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1
    ? Math.min(value, max)
    : fallback;
}

/** The lowercase hex SHA-256 of `bytes`, with the platform's Web Crypto (Node and browsers alike). */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** The `sha256:<hash>` a block refers to a file by, and the name it has under `assets/`. */
export async function assetRefOf(bytes: Uint8Array): Promise<string> {
  return `sha256:${await sha256OfBytes(bytes)}`;
}

function summarize(
  issues: ImportIssue[],
  items: ImportItem[],
  report: ConverterReportEntry[],
  extra: { formatVersion?: number; source?: ImportSource },
): ImportValidation {
  // Messages quote values from the bundle: escaped and cut, in one place.
  for (const list of [issues, ...items.map((i) => i.issues)])
    list.forEach((issue, i) => {
      list[i] = { ...issue, message: safeText(issue.message, 1000) };
    });
  const all = issues.concat(items.flatMap((i) => i.issues));
  const errors = all.filter((i) => i.severity === 'error').length;
  return {
    valid: errors === 0,
    ...(extra.formatVersion !== undefined
      ? { formatVersion: extra.formatVersion }
      : {}),
    ...(extra.source ? { source: extra.source } : {}),
    issues,
    items,
    report,
    counts: {
      modules: items.filter((i) => i.kind === 'module').length,
      manuals: items.filter((i) => i.kind === 'manual').length,
      assets: items.filter((i) => i.kind === 'asset').length,
      passthrough: items.reduce(
        (n, i) => n + (i.kind === 'module' ? i.passthrough : 0),
        0,
      ),
      clashes: all.filter((i) => i.code === 'id-clash').length,
      errors,
      warnings: all.filter((i) => i.severity === 'warning').length,
    },
  };
}
