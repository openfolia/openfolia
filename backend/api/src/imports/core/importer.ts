import type { ImportBundle, ProjectConfig } from '@openfolia/content-model';
import { z } from 'zod';
import { UnprocessableError } from '../../base/core/errors.js';
import type { ZipLimits } from './zip-archive.js';

/** An importer's ID: a lowercase key (`bundle`), as the form names it. */
export const ImporterId = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, 'a lowercase key, e.g. "bundle"');

/** The file an importer converts, as uploaded. */
export interface ImportFile {
  readonly bytes: Uint8Array;
  /** The name the client sent, as a `FileName`, if any. */
  readonly fileName?: string;
}

/**
 * What an importer may unpack: the same limits for every importer, from
 * the settings (`CCMS_IMPORT_*`), so a plugin cannot be talked into more.
 */
export type ImportLimits = ZipLimits;

/**
 * What an importer may know of the target: its configuration (`openfolia.yaml`
 * at the branch imported into), for a converter whose mapping lives there
 * (the DITA importer's `dita`). Read by the import, never by the importer.
 */
export interface ImportContext {
  readonly config: ProjectConfig;
}

/**
 * Port: turns an uploaded file into an import bundle in the documented
 * format (`@openfolia/content-model`, "Import format"), which the import then
 * validates and writes. The built-in importer reads that format itself
 * (`BundleImporter`); another source system is another importer behind
 * this port, registered as a provider of `IMPORTERS`, without touching
 * the API. An importer converts only: it never reads the repository, the
 * database or the network (the import hands it the target's
 * configuration, `context`), and what it returns is checked like any
 * bundle. The same file, options and configuration must give the same
 * bundle: a retried job converts again and matches the items by position.
 */
export abstract class Importer<O = unknown> {
  /** Stable, as the form names it. */
  abstract readonly id: string;
  /** For people choosing one, one line. */
  abstract readonly label: string;
  /** What it takes, one or two sentences. */
  abstract readonly description: string;
  /**
   * The options it takes, as a Zod schema: checked before `toBundle`, and
   * shown to clients as JSON Schema (`GET /importers`), so a screen can
   * render a form for them. A strict object; `{}` when it takes none.
   */
  abstract readonly options: z.ZodType<O>;

  /**
   * The bundle in `file`. A file it cannot read is 422 (an
   * `UnprocessableError` with a stable code, e.g. `invalid-archive`); what
   * it reads is never trusted (the import validates it).
   */
  abstract toBundle(
    file: ImportFile,
    options: O,
    limits: ImportLimits,
    context: ImportContext,
  ): Promise<ImportBundle>;
}

/** The Nest token every importer is provided under (`multi`-style: an array). */
export const IMPORTERS = Symbol('IMPORTERS');

/** The installed importers, by ID. */
export class ImporterRegistry {
  private readonly byId: ReadonlyMap<string, Importer>;

  constructor(importers: readonly Importer[]) {
    const byId = new Map<string, Importer>();
    for (const importer of importers) {
      if (!ImporterId.safeParse(importer.id).success) {
        throw new Error(`Not an importer ID: ${importer.id}`);
      }
      if (byId.has(importer.id)) {
        throw new Error(`Two importers with the ID ${importer.id}.`);
      }
      byId.set(importer.id, importer);
    }
    this.byId = byId;
  }

  /** Every importer, by ID. */
  list(): Importer[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The importer of that ID; 422 `unknown-importer` for none. */
  get(id: string): Importer {
    const importer = this.byId.get(id);
    if (!importer) {
      throw new UnprocessableError(
        'unknown-importer',
        `There is no importer "${id}"; GET /importers lists them.`,
        { importers: [...this.byId.keys()] },
      );
    }
    return importer;
  }
}

/** An importer's options as JSON Schema, for clients. */
export function optionsJsonSchema(importer: Importer): Record<string, unknown> {
  return z.toJSONSchema(importer.options, { io: 'input' }) as Record<
    string,
    unknown
  >;
}
