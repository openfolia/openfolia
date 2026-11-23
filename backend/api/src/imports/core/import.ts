import type {
  ConverterReportEntry,
  ImportSource,
} from '@openfolia/content-model';
import {
  isChangeSetId,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';
import type { AttachmentTypeRules } from '../../assets/core/attachment-types.js';

/**
 * Where an import stands: `validated` (stored with its report, waiting to
 * be applied), `applying` (its job runs), `applied` or `failed`. A dry run
 * is answered as `dry-run` and never stored.
 */
export const IMPORT_STATES = [
  'validated',
  'applying',
  'applied',
  'failed',
] as const;
export type ImportState = (typeof IMPORT_STATES)[number];

/** What the import does with an item. */
export const ITEM_ACTIONS = ['create', 'update', 'skip', 'refuse'] as const;
export type ItemAction = (typeof ITEM_ACTIONS)[number];

/** One finding about the bundle or an item: the validator's, or the import's own. */
export interface ReportIssue {
  readonly severity: 'error' | 'warning' | 'info';
  /** Stable: the validator's codes (`@openfolia/content-model`, "Import format") and the import's (`outside-scope`, `unsupported-image-type`, …). */
  readonly code: string;
  readonly message: string;
  /** Where in `import.json` (a JSON Pointer), when it is about a place in it. */
  readonly pointer?: string;
  /** The block it is about, by ID. */
  readonly at?: string;
}

/** One module, manual or file of the bundle, and what the import does with it. */
export interface ReportItem {
  readonly kind: 'module' | 'manual' | 'asset';
  /** The module's or manual's ID, or the file's `sha256:<hash>`. */
  readonly id: string;
  readonly lang?: string;
  /** Where it is in `import.json` (modules, manuals) or the archive (files). */
  readonly pointer: string;
  /** `meta.source.id` of a module: the item's ID in the source system. */
  readonly sourceId?: string;
  readonly action: ItemAction;
  /** Why it is skipped or refused (for `refuse`, every error). */
  readonly reasons: readonly ReportIssue[];
  /** Its other findings (warnings, information). */
  readonly issues: readonly ReportIssue[];
  /** How many findings it had in all, of which at most `MAX_ISSUES_PER_ITEM` each are listed. */
  readonly issueCount: number;
  /** A module's `passthrough` blocks: content kept verbatim. */
  readonly passthrough?: number;
  /** A file's size in bytes. */
  readonly size?: number;
  /** How a file is stored: as an image (PNG or JPEG) or as an attachment. */
  readonly usedAs?: 'image' | 'attachment';
}

/** The dry-run report: what an import would create, update, skip or refuse. */
export interface ImportReport {
  /** The validator found no error. */
  readonly valid: boolean;
  /** It can be applied: valid, nothing refused, within the limits, and something to write. */
  readonly applicable: boolean;
  /**
   * It can be applied with `skipRefused` (#758): `applicable`, or its refused items can be left
   * out and the rest stands as decided. The bundle without them, checked again in full, decides
   * every other item exactly as this report does, is applicable itself, and nothing about the
   * bundle as a whole is an error.
   */
  readonly applicableWithoutRefused: boolean;
  readonly formatVersion?: number;
  readonly source?: ImportSource;
  /** Findings about the bundle as a whole. */
  readonly issues: readonly ReportIssue[];
  /** Modules and manuals in document order, then files by name. */
  readonly items: readonly ReportItem[];
  /** The converter's own report, passed through (at most `MAX_CONVERTER_ENTRIES`). */
  readonly converterReport: readonly ConverterReportEntry[];
  readonly counts: {
    readonly modules: number;
    readonly manuals: number;
    readonly assets: number;
    readonly create: number;
    readonly update: number;
    readonly skip: number;
    readonly refuse: number;
    readonly passthrough: number;
    readonly errors: number;
    readonly warnings: number;
    /** Entries in the converter's report, all of them. */
    readonly converterReport: number;
  };
}

/** What an import's job has done so far. */
export interface ImportProgress {
  readonly phase: 'queued' | 'change-set' | 'assets' | 'files' | 'done';
  readonly assets: { readonly done: number; readonly total: number };
  readonly files: { readonly done: number; readonly total: number };
  /** Save points written, oldest first. */
  readonly commits: readonly string[];
}

/** Why an import's job failed, for the person reading it: a stable code and a sentence. */
export interface ImportFailure {
  readonly code: string;
  readonly detail: string;
}

/** Who imports, as the audit log names actors. */
export interface ImportActor {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

/** An import as stored (`imports`), for an hour after its upload (`IMPORT_TTL_MS`). */
export interface ImportRecord {
  /** A UUID version 7, made by the server. */
  readonly id: string;
  readonly importerId: string;
  /** The importer's options, as checked. */
  readonly options: Record<string, unknown>;
  readonly updateExisting: boolean;
  /** The branch it was checked against and goes into (as a change set's base). */
  readonly baseRef: string;
  /** That branch's commit when it was checked. */
  readonly baseCommit: string;
  readonly createdBy: ImportActor;
  /** The uploaded file's name, as a `FileName`. */
  readonly fileName: string | null;
  /** The uploaded file in the blob store. */
  readonly upload: {
    readonly sha256: string;
    readonly size: number;
    /** This import stored the bytes (they were not there before), so it removes them again. */
    readonly created: boolean;
  };
  readonly state: ImportState;
  readonly report: ImportReport;
  /** The change set it writes into, once its job made it. */
  readonly changeSetId: string | null;
  readonly progress: ImportProgress;
  readonly failure: ImportFailure | null;
  readonly createdAt: Date;
  /** Past it, a stored import that is not being applied is removed with its upload. */
  readonly expiresAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** An import as answered: a stored one, or a dry run's (`dryRun`, never stored). */
export type ImportView =
  | (ImportRecord & { readonly dryRun: false })
  | (Omit<ImportRecord, 'state' | 'upload'> & {
      readonly dryRun: true;
      readonly state: 'dry-run';
      readonly upload: { readonly size: number };
    });

/** How long a stored import (and its upload) is kept, from its upload, or from its job's end. */
export const IMPORT_TTL_MS = 60 * 60 * 1000;
/** The most reasons and the most other findings listed per item (`issueCount` counts all). */
export const MAX_ISSUES_PER_ITEM = 20;
/** The most bundle-level findings listed. */
export const MAX_BUNDLE_ISSUES = 200;
/** The most entries of the converter's report kept (`counts.converterReport` counts all). */
export const MAX_CONVERTER_ENTRIES = 1000;
/**
 * The most modules and manuals a bundle may hold, refused before any is
 * checked: twice what one change set takes (its 1,000 locks), so a bundle
 * with skips still fits, and the report stays bounded.
 */
export const MAX_IMPORT_ITEMS = 2000;
/** The most values (array elements, object members) `import.json` may hold, counted before it is checked. */
export const MAX_IMPORT_VALUES = 1_000_000;

/** A new import ID (a UUID version 7, as change sets have). */
export const newImportId = (now = Date.now()): string => newChangeSetId(now);

/** Whether `id` can be an import's ID (else it names none). */
export const isImportId = isChangeSetId;

export const NO_PROGRESS: ImportProgress = {
  phase: 'queued',
  assets: { done: 0, total: 0 },
  files: { done: 0, total: 0 },
  commits: [],
};

/**
 * The import's settings (`CCMS_IMPORT_*`, and the upload limits and
 * attachment rules of the asset routes, which an import's files go
 * through too). Provided by the module from the environment.
 */
export abstract class ImportSettings {
  /** The largest upload, in bytes. */
  abstract readonly maxBytes: number;
  /** The most entries in an archive. */
  abstract readonly maxFiles: number;
  /** The most bytes an archive's files hold together, unpacked. */
  abstract readonly maxUnpackedBytes: number;
  /** The most folders deep an archive's path may lie. */
  abstract readonly maxPathDepth: number;
  /** The deepest nesting of arrays and objects in `import.json`. */
  abstract readonly maxJsonDepth: number;
  abstract readonly maxDocumentBytes: number;
  /** The most files one save point of an import commits. */
  abstract readonly commitFiles: number;
  /** The most bytes of working copies one save point of an import commits. */
  abstract readonly commitBytes: number;
  /** `CCMS_MAX_UPLOAD_BYTES`: the largest image. */
  abstract readonly maxImageBytes: number;
  /** `CCMS_MAX_ATTACHMENT_BYTES`: the largest attachment. */
  abstract readonly maxAttachmentBytes: number;
  /** `CCMS_ATTACHMENT_TYPES_*`. */
  abstract readonly attachmentTypes: AttachmentTypeRules;
}
