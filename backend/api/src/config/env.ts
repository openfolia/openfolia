import { MAX_IMPORT_MAX_DEPTH } from '@openfolia/content-model';
import { defaultPoolSize, MAX_POOL_SIZE } from '@openfolia/render-typst';
import { z } from 'zod';
import { MAX_FONT_BYTES } from '../assets/core/asset-upload.js';
import { BlobEnv, checkBlobEnv } from './blob-env.js';
import { DatabaseEnv } from './database-env.js';
import {
  attachmentAllowRules,
  attachmentTypeRules,
} from './attachment-type-rules.js';
import { editorOrigins } from './editor-origins.js';
import { field, flag, text, wholeNumber } from './fields.js';
import { pdfWorkersFor, runsBackground, RoleEnv } from './role.js';
import { DEFAULT_DOCS_URL, docsUrl } from './docs-url.js';
import { checkSecretKeyEnv, SecretKeyEnv } from './secret-key-env.js';
import { checkSignInEnv, SignInEnv } from './sign-in-env.js';
import { publicUrl } from './public-url.js';
import {
  DEFAULT_DELIVERY_PER_MINUTE,
  DEFAULT_IGNORED_QUERY,
  ignoredQuery,
  maxAccess,
} from './delivery-env.js';
import { trustProxy } from './trust-proxy.js';
import { sourceUrl } from './source-url.js';
import { StartupError } from './startup-error.js';
import { checkPackageSendEnv, PackageSendEnv } from './package-send-env.js';
import { checkSearchEnv, SearchEnv } from './search-env.js';
import { checkStyleReviewEnv, StyleReviewEnv } from './style-review-env.js';
import { checkMailEnv, MailEnv } from './mail-env.js';
import { AuditEnv, checkAuditEnv } from './audit-env.js';
import { WebhooksEnv } from './webhooks-env.js';
import {
  DEFAULT_RELEASE_TAG,
  isReleaseTagPattern,
} from '../releases/core/release-tags.js';
import { MAX_ZIP_BYTES } from '../base/core/zip-stream.js';
import { DEFAULT_ARCHIVE_MAX_BYTES } from '../releases/core/release-archive.js';
import {
  DEFAULT_MAX_OUTPUTS,
  MAX_MAX_OUTPUTS,
} from '../releases/core/release-output.js';
import {
  DEFAULT_MAINTENANCE_BRANCH,
  isMaintenanceBranchPattern,
} from '../releases/core/maintenance-line.js';

/** `CCMS_DELIVERY_SHARED_MAX_AGE`'s default (#552): five minutes. */
export const DEFAULT_SHARED_MAX_AGE = 300;

/** `CCMS_CONTENT_INDEX_CACHE_MB`'s default (#552). */
export const DEFAULT_CONTENT_INDEX_CACHE_MB = 32;

/** `CCMS_CONTENT_CACHE_MB` and `CCMS_SEARCH_INDEXES`: their defaults (#479). */
export const DEFAULT_CONTENT_CACHE_MB = 64;
export const DEFAULT_SEARCH_INDEXES = 16;

/** `CCMS_MAX_UPLOAD_BYTES`: its default (10 MiB) and its largest value (1 GiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** `CCMS_MAX_ATTACHMENT_BYTES`: its default (50 MiB); its largest value is `MAX_UPLOAD_BYTES`. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 * `CCMS_MAX_FONT_BYTES`: its default (10 MiB) and its largest value (64 MiB). A font is read
 * whole into memory to be checked, so its cap stays far below the other uploads'.
 */
export const DEFAULT_MAX_FONT_BYTES = 10 * 1024 * 1024;

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

/** `CCMS_RENDITION_*` defaults (#255). */
export const DEFAULT_RENDITION_MAX_PIXELS = 40_000_000;
export const DEFAULT_RENDITION_TIMEOUT_MS = 10_000;
export const DEFAULT_RENDITION_CONCURRENCY = 2;
export const DEFAULT_RENDITION_MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/** The server's settings, read from the environment (documented in `.env.example`). */
export const Env = z
  .object({
    CCMS_CONTENT_DIR: field(text),
    /**
     * The shared token, for local use and demo mode (#38): unset, only
     * service accounts' tokens authenticate. Required in demo mode.
     */
    CCMS_API_TOKEN: field(
      z.string().trim().min(32, 'must be at least 32 characters').optional(),
    ),
    /**
     * `token` (default): service accounts' tokens, and the shared token
     * (when set) as a read-only service.
     * `demo`: the token is still required, and `X-Ccms-User` picks a seeded
     * user to act as. Never where real people sign in.
     */
    CCMS_AUTH_MODE: field(
      z
        .string()
        .trim()
        .pipe(z.enum(['token', 'demo'], 'must be token or demo'))
        .default('token'),
    ),
    CCMS_DEFAULT_REF: field(text.default('HEAD')),
    /**
     * How much parsed content one server keeps in memory, in MiB of the
     * files' text (default 64; parsed, it takes five to six times that).
     */
    CCMS_CONTENT_CACHE_MB: field(
      wholeNumber(1, 16_384).default(DEFAULT_CONTENT_CACHE_MB),
    ),
    /**
     * How much memory the content's indexes take at most, in MiB (#552; default 32): blob IDs
     * by path and folder, changed files, file histories, deletions, folder and module listings.
     */
    CCMS_CONTENT_INDEX_CACHE_MB: field(
      wholeNumber(1, 4_096).default(DEFAULT_CONTENT_INDEX_CACHE_MB),
    ),
    /** How many search indexes (one per commit and reading scope) one server keeps (default 16). */
    CCMS_SEARCH_INDEXES: field(
      wholeNumber(1, 1_024).default(DEFAULT_SEARCH_INDEXES),
    ),
    /** How release tags are named; `{product}` and `{revision}` are filled in. */
    CCMS_RELEASE_TAG: field(
      text
        .refine(
          isReleaseTagPattern,
          'must hold {product} and {revision} once each, as whole path components, and otherwise only A-Za-z0-9._/-',
        )
        .default(DEFAULT_RELEASE_TAG),
    ),
    /** How maintenance lines' branches are named (#60); `{product}` and `{revision}` are filled in. */
    CCMS_MAINTENANCE_BRANCH: field(
      text
        .refine(
          isMaintenanceBranchPattern,
          'must hold {product} and {revision} once each, as whole path components, otherwise only A-Za-z0-9._/-, and not start with change-sets/',
        )
        .default(DEFAULT_MAINTENANCE_BRANCH),
    ),
    /** Origins that may embed the HTML previews in a frame (`frame-ancestors`); comma-separated. */
    CCMS_EDITOR_ORIGINS: field(editorOrigins.optional()),
    /** Where this deployment's source code is (AGPL-3.0 section 13), for `GET /about` (#370). */
    CCMS_SOURCE_URL: field(sourceUrl.optional()),
    /** Where readers reach this deployment: the base of the stable addresses and their QR codes (#450). */
    CCMS_PUBLIC_URL: field(publicUrl.optional()),
    /** The most a project's `delivery.access` may open its stable addresses (#553). */
    CCMS_DELIVERY_MAX_ACCESS: field(maxAccess.default('public')),
    /** The query parameters a stable address ignores: tracking parameters of shared links (#553). */
    CCMS_DELIVERY_IGNORED_QUERY: field(
      ignoredQuery.default([...DEFAULT_IGNORED_QUERY]),
    ),
    /**
     * What identifies this build (#552): the same on every server of one build (the image's
     * commit, say), so their stable address pages' ETags agree; unset, one per process.
     */
    CCMS_BUILD_ID: field(
      z
        .string()
        .trim()
        .regex(
          /^[A-Za-z0-9._:+-]{1,128}$/,
          'must be 1 to 128 of A-Za-z0-9._:+-',
        )
        .optional(),
    ),
    /** How long a shared cache keeps a public stable address's image, in seconds (#552; default 300, 0 to 86,400). */
    CCMS_DELIVERY_SHARED_MAX_AGE: field(
      wholeNumber(0, 86_400).default(DEFAULT_SHARED_MAX_AGE),
    ),
    // #574: the client's address behind a proxy, and the stable addresses' rate limit.
    /** Which proxies to believe about the client's address: `none` (default), a hop count, or addresses and subnets. */
    CCMS_TRUST_PROXY: field(trustProxy.default(false)),
    /** Pages, PDFs and QR codes one client (an address, or an actor with a token) may ask for under `/d/` per minute, on each server (default 60; 0: no limit); past it, 429 `rate-limited`. */
    CCMS_DELIVERY_PER_MINUTE: field(
      wholeNumber(0, 6_000).default(DEFAULT_DELIVERY_PER_MINUTE),
    ),
    /** Where the user guide is, for the editor's help links (#471, #221); `off`: none. */
    CCMS_DOCS_URL: field(docsUrl.default(DEFAULT_DOCS_URL)),
    HOST: field(text.default('127.0.0.1')),
    /** 0 lets the system pick a free port. */
    PORT: field(wholeNumber(0, 65_535).default(3100)),
    CCMS_PDF_WORKERS: field(wholeNumber(1, MAX_POOL_SIZE).optional()),
    /**
     * How many release files one server renders at once (#497); at most the
     * PDF workers (`CCMS_PDF_WORKERS`, else one per spare core), by default
     * half of them, at least one.
     */
    CCMS_RENDER_CONCURRENCY: field(wholeNumber(1, MAX_POOL_SIZE).optional()),
    CCMS_PDF_QUEUE: field(wholeNumber(0, 10_000).optional()),
    // One day at most; setTimeout cannot go beyond ~24.8 days.
    CCMS_PDF_TIMEOUT_MS: field(wholeNumber(1, 86_400_000).optional()),
    /**
     * The memory one PDF worker process may use, in MiB (#396): past it the process is stopped
     * and the PDF answers 422 `render-memory-exceeded`. 256 to 65536; default 2048.
     */
    CCMS_PDF_MEMORY_MB: field(wholeNumber(256, 65_536).optional()),
    /** The largest image `POST /change-sets/:id/assets` stores, in bytes (default 10 MiB, at most 1 GiB). */
    CCMS_MAX_UPLOAD_BYTES: field(
      wholeNumber(1, MAX_UPLOAD_BYTES).default(DEFAULT_MAX_UPLOAD_BYTES),
    ),
    /** The largest attachment `POST /change-sets/:id/assets?kind=attachment` stores, in bytes (default 50 MiB, at most 1 GiB). */
    CCMS_MAX_ATTACHMENT_BYTES: field(
      wholeNumber(1, MAX_UPLOAD_BYTES).default(DEFAULT_MAX_ATTACHMENT_BYTES),
    ),
    /** The largest font `POST /change-sets/:id/assets?kind=font` stores, in bytes (default 10 MiB, at most 64 MiB). */
    CCMS_MAX_FONT_BYTES: field(
      wholeNumber(1, MAX_FONT_BYTES).default(DEFAULT_MAX_FONT_BYTES),
    ),
    /**
     * The most bytes uploaded media and archived release PDFs may hold
     * together (#404); past it uploads are refused (409
     * `storage-limit-reached`). Unset: no limit (the default).
     */
    CCMS_STORAGE_LIMIT_BYTES: field(
      z
        .string()
        .trim()
        .regex(/^\d{1,16}$/, 'must be a whole number of bytes from 1')
        .transform(Number)
        .pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))
        .optional(),
    ),
    /** How often the storage used is counted afresh, in hours (default 24, from 1 to 8,760). */
    CCMS_STORAGE_RECOUNT_HOURS: field(wholeNumber(1, 8_760).default(24)),
    /** When set, the only attachment types taken (media types, `type/*`, `.ext`; comma-separated). */
    CCMS_ATTACHMENT_TYPES_ALLOW: field(attachmentAllowRules.optional()),
    /** Attachment types refused on top of the dangerous ones (same form). */
    CCMS_ATTACHMENT_TYPES_DENY: field(attachmentTypeRules.default([])),
    /** Dangerous attachment types (HTML, SVG, executables, scripts) taken all the same (same form). */
    CCMS_ATTACHMENT_TYPES_OPEN: field(attachmentTypeRules.default([])),
    /** The most pixels (width × height) an image a rendition is made of may have (default 40 million). */
    CCMS_RENDITION_MAX_PIXELS: field(
      wholeNumber(1, 268_402_689).default(DEFAULT_RENDITION_MAX_PIXELS),
    ),
    /** How long making one rendition may take, in milliseconds (default 10 s). */
    CCMS_RENDITION_TIMEOUT_MS: field(
      wholeNumber(100, 120_000).default(DEFAULT_RENDITION_TIMEOUT_MS),
    ),
    /** How many renditions one server makes at once (default 2). */
    CCMS_RENDITION_CONCURRENCY: field(
      wholeNumber(1, 32).default(DEFAULT_RENDITION_CONCURRENCY),
    ),
    /** The largest file a rendition is made of, in bytes (default 50 MiB, at most 1 GiB). */
    CCMS_RENDITION_MAX_SOURCE_BYTES: field(
      wholeNumber(1, MAX_UPLOAD_BYTES).default(
        DEFAULT_RENDITION_MAX_SOURCE_BYTES,
      ),
    ),
    /** How often the notifications' fan-out reads the outbox, in ms (default 3 s; 0: not on a timer). */
    CCMS_NOTIFICATIONS_POLL_MS: field(wholeNumber(0, 3_600_000).default(3_000)),
    /** How many days read notifications are kept (default 90). */
    CCMS_NOTIFICATIONS_KEEP_DAYS: field(wholeNumber(1, 36_500).default(90)),
    /** Hours after which the backup status warns that there is no good backup (#529; default 26, from 1 to 8,760). */
    CCMS_BACKUP_WARN_AFTER_HOURS: field(wholeNumber(1, 8_760).default(26)),
    /** Failed authentications one client address may make per window before it is refused (429; default 20; 0: no limit). */
    CCMS_AUTH_FAILURES_MAX: field(wholeNumber(0, 1_000_000).default(20)),
    /** The window of `CCMS_AUTH_FAILURES_MAX`, in ms (default 60 s, from 1 s to 1 day). */
    CCMS_AUTH_FAILURES_WINDOW_MS: field(
      wholeNumber(1_000, 86_400_000).default(60_000),
    ),
    /** Failed password checks and reset requests one account may have per window, together, before it is refused (429; #610; default 10; 0: no limit). */
    CCMS_PASSWORD_FAILURES_MAX: field(wholeNumber(0, 1_000_000).default(10)),
    /** The window of `CCMS_PASSWORD_FAILURES_MAX`, in ms (default 15 minutes, from 1 s to 1 day). */
    CCMS_PASSWORD_FAILURES_WINDOW_MS: field(
      wholeNumber(1_000, 86_400_000).default(900_000),
    ),
    /** How often each job queue is polled, in ms (default 2 s; 0: this server runs no jobs, it only enqueues). */
    CCMS_JOBS_POLL_MS: field(
      wholeNumber(0, 3_600_000)
        .refine((ms) => ms === 0 || ms >= 500, 'must be 0 or at least 500')
        .default(2_000),
    ),
    /** Most connections of the job queue's own pool (default 4). */
    CCMS_JOBS_POOL_MAX: field(wholeNumber(1, 100).default(4)),
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
    /** The largest ZIP of a release's files `GET /releases/:id/outputs/archive` serves, in bytes (default 2 GiB, at most 4 GiB less one byte: no ZIP64). */
    CCMS_RELEASE_ARCHIVE_MAX_BYTES: field(
      wholeNumber(1, MAX_ZIP_BYTES).default(DEFAULT_ARCHIVE_MAX_BYTES),
    ),
    /** The most outputs (manuals × variants × languages) one release plans (#477); one with more gets none (default 20,000). */
    CCMS_RELEASE_MAX_OUTPUTS: field(
      wholeNumber(1, MAX_MAX_OUTPUTS).default(DEFAULT_MAX_OUTPUTS),
    ),
    /**
     * Whether each release gets its offline packages (#59): a ZIP per language and audience
     * level, built once its PDFs are done (default true).
     */
    CCMS_OFFLINE_PACKAGES: field(flag.default(true)),
    ...PackageSendEnv.shape,
    ...RoleEnv.shape,
    ...DatabaseEnv.shape,
    ...BlobEnv.shape,
    ...StyleReviewEnv.shape,
    ...SearchEnv.shape,
    ...WebhooksEnv.shape,
    ...MailEnv.shape,
    ...SecretKeyEnv.shape,
    ...SignInEnv.shape,
    ...AuditEnv.shape,
  })
  .superRefine(checkBlobEnv)
  .superRefine(checkStyleReviewEnv)
  .superRefine(checkSearchEnv)
  .superRefine(checkSecretKeyEnv)
  .superRefine(checkSignInEnv)
  .superRefine(checkMailEnv)
  .superRefine(checkAuditEnv)
  .superRefine(checkPackageSendEnv)
  .superRefine((env, ctx) => {
    // Rendering past the PDF workers would only queue in their pool, ahead of
    // nothing and in the way of readers' PDFs. Only where release files render
    // (`all`, `worker`): the `api` role renders none, so the setting (in a
    // settings file shared with the workers) means nothing there (#527).
    if (!runsBackground(env.CCMS_ROLE)) return;
    const workers = pdfWorkersFor(
      env.CCMS_ROLE,
      env.CCMS_PDF_WORKERS,
      defaultPoolSize(),
    );
    if (
      env.CCMS_RENDER_CONCURRENCY !== undefined &&
      env.CCMS_RENDER_CONCURRENCY > workers
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CCMS_RENDER_CONCURRENCY'],
        message: `must be at most the PDF workers (${workers}: CCMS_PDF_WORKERS, else one per spare core)`,
      });
    }
    if (env.CCMS_AUTH_MODE === 'demo' && env.CCMS_API_TOKEN === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['CCMS_API_TOKEN'],
        message: 'is required in demo mode (CCMS_AUTH_MODE=demo)',
      });
    }
    // A line's branch and a release's tag of one name would make the
    // name ambiguous: a missing branch would read as the tag.
    if (
      env.CCMS_MAINTENANCE_BRANCH.toLowerCase() ===
      env.CCMS_RELEASE_TAG.toLowerCase()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CCMS_MAINTENANCE_BRANCH'],
        message: 'must differ from CCMS_RELEASE_TAG',
      });
    }
  });
export type Env = z.infer<typeof Env>;

/** For `ConfigModule`: fails startup with every problem listed. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = Env.safeParse(raw);
  if (!result.success) {
    throw new StartupError(
      `Invalid settings (see .env.example):\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
