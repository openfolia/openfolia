import { z } from 'zod';
import { BlockId, ModuleId, SingleLine } from '../ids.js';
import { Manifest, ManifestEntry } from '../manifest.js';
import { Module } from '../module.js';

/**
 * The import format's version. A bundle with a newer one is refused; an
 * older one is migrated by the validator (`IMPORT_FORMAT_MIGRATIONS`) before
 * it is checked. Bumped on every change a version-1 reader can't read.
 */
export const CURRENT_IMPORT_FORMAT_VERSION = 1;

/** The name of the JSON document at the root of an import archive. */
export const IMPORT_DOCUMENT_PATH = 'import.json';

/** The folder in an import archive holding the files, each named by its SHA-256. */
export const IMPORT_ASSETS_FOLDER = 'assets/';

/** Where a bundle came from: free text, for people reading the report. */
export const ImportSource = z.strictObject({
  /** The system the content was exported from, e.g. "Example Wiki 4.2". */
  system: SingleLine.max(200),
  /** When it was exported, as the converter knows it, e.g. "2026-11-02" (free text). */
  exportedAt: SingleLine.max(200).optional(),
  /** Anything else worth knowing about the export, in one line. */
  description: SingleLine.max(1000).optional(),
});
export type ImportSource = z.infer<typeof ImportSource>;

/**
 * One thing the converter could not map (or mapped only partly), for the
 * source item it was found in. The converter writes these; the validator
 * passes them through unchanged.
 */
export const ConverterReportEntry = z.strictObject({
  /** The source item's ID in the source system. */
  sourceId: SingleLine.max(500),
  /** What kind of item it was in the source, e.g. "topic" or "table" (free text). */
  sourceKind: SingleLine.max(100).optional(),
  /** What was lost or changed, for a person to follow up. */
  message: z.string().min(1).max(4000),
  /** The module the item ended up in, if any. */
  module: ModuleId.optional(),
  /** The block in that module, if any. */
  block: BlockId.optional(),
});
export type ConverterReportEntry = z.infer<typeof ConverterReportEntry>;

/**
 * A manual as an import bundle holds it: an assembled manifest (at least one entry) without
 * translation records (#656), which translation imports write. A derived manual (#451) is made
 * here, from a manual already imported, never imported.
 */
export const ImportedManifest = Manifest.omit({
  translations: true,
  kind: true,
  rule: true,
}).extend({ entries: z.array(ManifestEntry).min(1) });

/**
 * `import.json`: the whole content of an import bundle except the files.
 * Modules (in any language) and manuals are the content model's own JSON;
 * images and attachments refer to files under `assets/` by their SHA-256.
 */
export const ImportDocument = z.strictObject({
  formatVersion: z.literal(CURRENT_IMPORT_FORMAT_VERSION),
  source: ImportSource.optional(),
  /** Modules as `Module` JSON. A translation is the same `id` in another `meta.lang`. */
  modules: z.array(Module),
  /** Manuals as manifests. */
  manuals: z.array(ImportedManifest).default([]),
  /** What the converter could not map, per source item. */
  report: z.array(ConverterReportEntry).default([]),
});
export type ImportDocument = z.infer<typeof ImportDocument>;

/**
 * The document's frame: everything but the modules and manuals, which the
 * validator checks one at a time (so one broken module doesn't hide the
 * rest) with the same schemas.
 */
export const ImportFrame = ImportDocument.extend({
  formatVersion: z.int(),
  modules: z.array(z.unknown()),
  manuals: z.array(z.unknown()).default([]),
});

/**
 * Migrations from older format versions, by the version they read: each
 * turns a document of that version into one of the next. None yet, as 1 is
 * the first version.
 */
export const IMPORT_FORMAT_MIGRATIONS: ReadonlyMap<
  number,
  (document: Record<string, unknown>) => Record<string, unknown>
> = new Map();
