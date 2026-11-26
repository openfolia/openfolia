import { MAX_IMPORT_MAX_DEPTH } from '@openfolia/content-model';
import { z } from 'zod';
import { field, wholeNumber } from '../config/fields.js';
import { defineSettings } from '../config/settings-registry.js';
import { MAX_UPLOAD_BYTES } from '../config/upload-limits.js';

/** `CCMS_IMPORT_*` defaults and limits (#256). */
export const DEFAULT_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_IMPORT_MAX_FILES = 5_000;
export const MAX_IMPORT_FILES = 65_534;
export const DEFAULT_IMPORT_MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_IMPORT_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024 - 1;
export const DEFAULT_IMPORT_MAX_PATH_DEPTH = 4;
export const DEFAULT_IMPORT_MAX_JSON_DEPTH = 128;
export const DEFAULT_IMPORT_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** `CCMS_IMPORT_CONVERT_*` (#432): a DITA conversion's own process, its heap in MiB and its time in ms. */
export const DEFAULT_IMPORT_CONVERT_MAX_MEMORY_MB = 1024;
export const DEFAULT_IMPORT_CONVERT_TIMEOUT_MS = 120_000;
export const MAX_IMPORT_DOCUMENT_BYTES = 32 * 1024 * 1024;
/** A save point's own limits (`MAX_COMMIT_CHANGES`, `MAX_COMMIT_JSON_BYTES`), the most an import's may take. */
export const MAX_IMPORT_COMMIT_FILES = 1_000;
export const MAX_IMPORT_COMMIT_BYTES = 32 * 1024 * 1024;

/** The content import's settings: part of `Env`. */
export const ImportEnv = z.object({
  /** The largest upload `POST /imports` takes, in bytes (default 64 MiB, at most 1 GiB). */
  CCMS_IMPORT_MAX_BYTES: field(
    wholeNumber(1, MAX_UPLOAD_BYTES).default(DEFAULT_IMPORT_MAX_BYTES),
  ),
  /** The most entries (files and folders) an import archive may hold (default 5,000). */
  CCMS_IMPORT_MAX_FILES: field(
    wholeNumber(1, MAX_IMPORT_FILES).default(DEFAULT_IMPORT_MAX_FILES),
  ),
  /** The most bytes an import archive's files may hold together, unpacked (default 256 MiB). */
  CCMS_IMPORT_MAX_UNPACKED_BYTES: field(
    wholeNumber(1, MAX_IMPORT_UNPACKED_BYTES).default(
      DEFAULT_IMPORT_MAX_UNPACKED_BYTES,
    ),
  ),
  /** The most folders deep a path in an import archive may lie (default 4; `assets/<hash>` lies in 1). */
  CCMS_IMPORT_MAX_PATH_DEPTH: field(
    wholeNumber(1, 64).default(DEFAULT_IMPORT_MAX_PATH_DEPTH),
  ),
  /** The deepest nesting of arrays and objects in `import.json` (default 128, at most 256). */
  CCMS_IMPORT_MAX_JSON_DEPTH: field(
    wholeNumber(16, MAX_IMPORT_MAX_DEPTH).default(
      DEFAULT_IMPORT_MAX_JSON_DEPTH,
    ),
  ),
  /** The largest `import.json` an import reads, in bytes, refused before it is parsed (default 8 MiB, at most 32 MiB). */
  CCMS_IMPORT_MAX_DOCUMENT_BYTES: field(
    wholeNumber(1, MAX_IMPORT_DOCUMENT_BYTES).default(
      DEFAULT_IMPORT_MAX_DOCUMENT_BYTES,
    ),
  ),
  /** The JavaScript heap (old space; the archive's bytes come on top) of a DITA conversion's own process, in MiB (default 1,024; 64 to 16,384); past it, the import is refused, the server unharmed. */
  CCMS_IMPORT_CONVERT_MAX_MEMORY_MB: field(
    wholeNumber(64, 16_384).default(DEFAULT_IMPORT_CONVERT_MAX_MEMORY_MB),
  ),
  /** The longest a DITA conversion may take, in ms (default 120,000; 1,000 to 3,600,000); then it is stopped and the import refused. */
  CCMS_IMPORT_CONVERT_TIMEOUT_MS: field(
    wholeNumber(1_000, 3_600_000).default(DEFAULT_IMPORT_CONVERT_TIMEOUT_MS),
  ),
  /** The most modules and manuals one save point of an import commits (default and most 1,000). */
  CCMS_IMPORT_COMMIT_FILES: field(
    wholeNumber(1, MAX_IMPORT_COMMIT_FILES).default(MAX_IMPORT_COMMIT_FILES),
  ),
  /** The most bytes of working copies one save point of an import commits (default and most 32 MiB). */
  CCMS_IMPORT_COMMIT_BYTES: field(
    wholeNumber(1, MAX_IMPORT_COMMIT_BYTES).default(MAX_IMPORT_COMMIT_BYTES),
  ),
});

/** The content import's settings (`src/settings.ts` registers them). */
export const IMPORT_SETTINGS = defineSettings('imports', ImportEnv);
