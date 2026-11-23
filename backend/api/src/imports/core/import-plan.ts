import {
  type ImportBundle,
  type ImportIssue,
  type ImportItem,
  type ImportValidation,
  type Manifest,
  type Module,
  printManifest,
  printModule,
  type ProjectConfig,
  walk,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import {
  acceptedUploadType,
  MAX_UPLOADS_PER_CHANGE_SET,
  SNIFF_BYTES,
  type UploadKind,
} from '../../assets/core/asset-upload.js';
import {
  ATTACHMENT_SNIFF_BYTES,
  attachmentType,
  refusal,
} from '../../assets/core/attachment-types.js';
import {
  DomainError,
  ForbiddenError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { isSha256 } from '../../blobs/core/blob-store.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import {
  type LockSubject,
  type SubjectOf,
  MAX_LOCKS_PER_HOLDER,
  subjectName,
} from '../../change-sets/core/lock.js';
import { checkSubject, kindOf } from '../../change-sets/core/subject-kinds.js';
import {
  MAX_WORKING_COPY_BYTES,
  workingCopyBytes,
} from '../../change-sets/core/working-copy.js';
import { workingCopySubject } from '../../change-sets/core/working-copy-rules.js';
import { recordAt } from '../../change-sets/core/translation-records.js';
import {
  type ImportReport,
  type ImportSettings,
  type ItemAction,
  MAX_BUNDLE_ISSUES,
  MAX_CONVERTER_ENTRIES,
  MAX_ISSUES_PER_ITEM,
  type ReportIssue,
  type ReportItem,
} from './import.js';

/** A module or manual the import writes, as a working copy and then at a save point. */
export interface PlannedWrite {
  readonly subject: LockSubject;
  readonly content: Module | Manifest;
  /** Its size as a working copy (`workingCopyBytes`), for batching save points. */
  readonly bytes: number;
}

/** A file the import uploads into its change set, as the asset route would. */
export interface PlannedUpload {
  readonly sha256: string;
  readonly kind: UploadKind;
  /** An attachment's `fileName` (the first attachment block's that names the file). */
  readonly fileName?: string;
  readonly bytes: Uint8Array;
}

/** What an import does: its report, and the writes and uploads behind its `create` and `update` items. */
export interface ImportPlan {
  readonly report: ImportReport;
  /** Modules (the source language first, then by language and ID), then manuals by ID. */
  readonly writes: readonly PlannedWrite[];
  /** Files by hash. */
  readonly uploads: readonly PlannedUpload[];
}

export interface PlanContext {
  readonly actor: Actor;
  /** The target branch as the actor reads it. */
  readonly snapshot: ReadableContent;
  readonly config: ProjectConfig;
  /** Write modules and manuals that exist already (else they are skipped). */
  readonly updateExisting: boolean;
  readonly settings: Pick<
    ImportSettings,
    'maxImageBytes' | 'maxAttachmentBytes' | 'attachmentTypes'
  >;
}

const issue = (
  severity: ReportIssue['severity'],
  code: string,
  message: string,
  extra: Pick<ReportIssue, 'pointer' | 'at'> = {},
): ReportIssue => ({ severity, code, message, ...extra });

const fromValidator = (found: ImportIssue): ReportIssue => ({
  severity: found.severity,
  code: found.code,
  message: found.message,
  ...(found.pointer !== undefined && { pointer: found.pointer }),
  ...(found.at !== undefined && { at: found.at }),
});

/**
 * Decides what an import does with each item of a validated bundle, by the
 * rules every edit follows, and says why:
 *
 * - **refuse** an item with a validation error, one outside what the actor
 *   may change (the subject kind's `checkChange`, the very check saving its
 *   working copy runs: `outside-scope`, one answer whatever the reason), a
 *   module or manual larger than a working copy may be (`too-large`), and a
 *   file the asset route would refuse (`unsupported-image-type`,
 *   `unsupported-attachment-type`, `too-large`);
 * - **skip** a module (in its language) or manual that exists at the target
 *   (`exists`) unless `updateExisting`; with it, one the target holds
 *   exactly as the bundle has it (`unchanged`: the same file once printed),
 *   so importing the same source again writes nothing; and a file no written
 *   module uses (`unused`);
 * - **update** an existing one with `updateExisting`; **create** the rest.
 *
 * Existence is what the actor reads at the target; a hidden file at the
 * same path is refused as outside their scope, as taking its lock would be.
 * The plan is applicable only when the bundle is valid, nothing is
 * refused, it stays within one change set's limits (locks, uploads) and
 * something is written.
 */
export async function planImport(
  bundle: ImportBundle,
  validation: ImportValidation,
  context: PlanContext,
): Promise<ImportPlan> {
  const { snapshot, config } = context;
  const existingModules = new Set(
    (await snapshot.modules()).map((file) => `${file.lang}/${file.id}`),
  );
  const existingManuals = new Set(
    (await snapshot.manuals()).map((manual) => manual.id),
  );
  const items: ReportItem[] = [];
  const writes: PlannedWrite[] = [];
  const bundleIssues: ReportIssue[] = validation.issues.map(fromValidator);
  let ownErrors = 0;

  const decide = async (
    item: ImportItem,
    subject: LockSubject | undefined,
    content: Module | Manifest | undefined,
    exists: boolean,
  ): Promise<ReportItem> => {
    const found = item.issues.map(fromValidator);
    const own: ReportIssue[] = [];
    const invalid =
      !subject || !content || found.some((i) => i.severity === 'error');
    const unchanged =
      !invalid &&
      exists &&
      context.updateExisting &&
      subject !== undefined &&
      content !== undefined &&
      (await sameAsStored(snapshot, subject, content));
    const skipped =
      !invalid && exists && (!context.updateExisting || unchanged);
    // Only what would be written is checked as a change: a skip writes nothing.
    if (subject && content && !invalid && !skipped) {
      own.push(...(await changeRefusals(context, subject, content)));
    }
    ownErrors += own.length;
    const all = [...found, ...own];
    const errors = all.filter((i) => i.severity === 'error');
    let action: ItemAction;
    let reasons: ReportIssue[];
    if (invalid || errors.length > 0) {
      action = 'refuse';
      reasons = errors;
    } else if (skipped) {
      action = 'skip';
      reasons = [
        unchanged
          ? issue(
              'info',
              'unchanged',
              'The target holds it exactly like this already; there is nothing to update.',
            )
          : issue(
              'info',
              'exists',
              'It exists at the target already; it is skipped unless "update existing" is set.',
            ),
      ];
    } else {
      action = exists ? 'update' : 'create';
      reasons = [];
    }
    const others = all.filter((i) => !reasons.includes(i));
    return {
      kind: item.kind,
      id: item.id,
      ...(item.kind === 'module' &&
        item.lang !== undefined && { lang: item.lang }),
      pointer: item.pointer,
      ...(item.kind === 'module' &&
        item.sourceId !== undefined && { sourceId: item.sourceId }),
      action,
      reasons: reasons.slice(0, MAX_ISSUES_PER_ITEM),
      issues: others.slice(0, MAX_ISSUES_PER_ITEM),
      issueCount: reasons.length + others.length,
      ...(item.kind === 'module' && { passthrough: item.passthrough }),
    };
  };

  const subjectOf = (named: LockSubject): LockSubject | undefined => {
    try {
      return workingCopySubject(named);
    } catch (error) {
      if (error instanceof DomainError) return undefined;
      throw error;
    }
  };

  for (const item of validation.items) {
    if (item.kind === 'module') {
      const module = item.module;
      const subject =
        module &&
        subjectOf({
          type: 'module',
          lang: module.meta.lang,
          moduleId: module.id,
        });
      const exists =
        subject?.type === 'module' &&
        existingModules.has(`${subject.lang}/${subject.moduleId}`);
      const decided = await decide(item, subject, module, exists);
      items.push(decided);
      if (subject && module && isWrite(decided.action)) {
        writes.push({
          subject,
          content: module,
          bytes: workingCopyBytes(module),
        });
      }
    } else if (item.kind === 'manual') {
      const imported = item.manifest;
      const subject =
        imported && subjectOf({ type: 'manual', manualId: imported.id });
      const exists =
        subject?.type === 'manual' && existingManuals.has(subject.manualId);
      // The import format has no translation record (`ImportedManifest`): an
      // update keeps the committed one, which only its translation manager
      // changes (#663).
      const manifest =
        imported && subject?.type === 'manual' && exists
          ? await withCommittedRecord(snapshot, subject, imported)
          : imported;
      const decided = await decide(item, subject, manifest, exists);
      items.push(decided);
      if (subject && manifest && isWrite(decided.action)) {
        writes.push({
          subject,
          content: manifest,
          bytes: workingCopyBytes(manifest),
        });
      }
    }
  }

  // The files the written modules use, and how: an image block's file is
  // stored as an image, any other as an attachment under its block's name.
  const uses = new Map<string, { image: boolean; fileName?: string }>();
  for (const { content } of writes) {
    if (!('blocks' in content)) continue;
    for (const { kind, node } of walk(content.blocks)) {
      if (kind !== 'block') continue;
      if (node.type !== 'image' && node.type !== 'attachment') continue;
      const hash = node.asset.startsWith('sha256:')
        ? node.asset.slice('sha256:'.length)
        : '';
      if (!isSha256(hash)) continue;
      const use = uses.get(hash) ?? { image: false };
      if (node.type === 'image') use.image = true;
      else if (use.fileName === undefined) use.fileName = node.fileName;
      uses.set(hash, use);
    }
  }
  const uploads: PlannedUpload[] = [];
  for (const item of validation.items) {
    if (item.kind !== 'asset') continue;
    const hash = item.id.slice('sha256:'.length);
    const use = uses.get(hash);
    const bytes = bundle.files.get(item.pointer);
    const found = item.issues.map(fromValidator);
    const own: ReportIssue[] = [];
    const usedAs = use?.image ? 'image' : 'attachment';
    if (use && bytes) {
      own.push(...fileRefusals(bytes, usedAs, use.fileName, context.settings));
    }
    ownErrors += own.length;
    const all = [...found, ...own];
    const errors = all.filter((i) => i.severity === 'error');
    let action: ItemAction;
    let reasons: ReportIssue[];
    if (errors.length > 0 || !bytes) {
      action = 'refuse';
      reasons = errors;
    } else if (!use) {
      action = 'skip';
      reasons = [
        issue(
          'info',
          'unused',
          'No module the import writes uses it: it is not uploaded.',
        ),
      ];
    } else {
      action = 'create';
      reasons = [];
      uploads.push({
        sha256: hash,
        kind: usedAs,
        ...(usedAs === 'attachment' &&
          use.fileName !== undefined && { fileName: use.fileName }),
        bytes,
      });
    }
    const others = all.filter((i) => !reasons.includes(i));
    items.push({
      kind: 'asset',
      id: item.id,
      pointer: item.pointer,
      action,
      reasons: reasons.slice(0, MAX_ISSUES_PER_ITEM),
      issues: others.slice(0, MAX_ISSUES_PER_ITEM),
      issueCount: reasons.length + others.length,
      size: item.size,
      ...(use && { usedAs }),
    });
  }

  if (writes.length > MAX_LOCKS_PER_HOLDER) {
    ownErrors++;
    bundleIssues.push(
      issue(
        'error',
        'too-many-subjects',
        `The import writes ${writes.length} modules and manuals; one change set takes at most ${MAX_LOCKS_PER_HOLDER} (the locks one person may hold).`,
      ),
    );
  }
  if (uploads.length > MAX_UPLOADS_PER_CHANGE_SET) {
    ownErrors++;
    bundleIssues.push(
      issue(
        'error',
        'too-many-files',
        `The import uploads ${uploads.length} files; one change set takes at most ${MAX_UPLOADS_PER_CHANGE_SET}.`,
      ),
    );
  }
  if (writes.length === 0) {
    bundleIssues.push(
      issue(
        'info',
        'nothing-to-import',
        'Nothing would be created or updated.',
      ),
    );
  }

  const count = (action: ItemAction) =>
    items.filter((i) => i.action === action).length;
  const refused = count('refuse');
  const bundleErrors = bundleIssues.some((i) => i.severity === 'error');
  const source = config.languages.source;
  writes.sort(
    (a, b) =>
      writeOrder(a, source) - writeOrder(b, source) || compareWrites(a, b),
  );
  uploads.sort((a, b) =>
    a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0,
  );
  const applicable =
    validation.valid && refused === 0 && !bundleErrors && writes.length > 0;
  return {
    report: {
      valid: validation.valid,
      applicable,
      // Without refused items there is nothing to leave out; with them, the
      // pipeline checks the rest (`planWithRest`, #758).
      applicableWithoutRefused: applicable,
      ...(validation.formatVersion !== undefined && {
        formatVersion: validation.formatVersion,
      }),
      ...(validation.source !== undefined && { source: validation.source }),
      issues: bundleIssues.slice(0, MAX_BUNDLE_ISSUES),
      items,
      converterReport: validation.report.slice(0, MAX_CONVERTER_ENTRIES),
      counts: {
        modules: validation.counts.modules,
        manuals: validation.counts.manuals,
        assets: validation.counts.assets,
        create: count('create'),
        update: count('update'),
        skip: count('skip'),
        refuse: refused,
        passthrough: validation.counts.passthrough,
        errors: validation.counts.errors + ownErrors,
        warnings: validation.counts.warnings,
        converterReport: validation.report.length,
      },
    },
    writes,
    uploads,
  };
}

/**
 * Why a module or manual may not be written: what saving its working copy
 * would refuse (the subject kind's `checkChange`, one 403 whatever the
 * reason: `outside-scope`; content naming another subject) and a size
 * past a working copy's.
 */
async function changeRefusals(
  context: PlanContext,
  subject: LockSubject,
  content: Module | Manifest,
): Promise<ReportIssue[]> {
  const refusals: ReportIssue[] = [];
  try {
    checkSubject(subject, content);
    await kindOf(subject).checkChange(
      context.actor,
      context.snapshot,
      subject,
      content as never,
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      refusals.push(issue('error', 'outside-scope', error.message));
    } else if (error instanceof UnprocessableError) {
      refusals.push(issue('error', error.code, error.message));
    } else {
      throw error;
    }
  }
  if (workingCopyBytes(content) > MAX_WORKING_COPY_BYTES) {
    refusals.push(
      issue(
        'error',
        'too-large',
        `It is larger than a working copy may be (${MAX_WORKING_COPY_BYTES} bytes of JSON).`,
      ),
    );
  }
  return refusals;
}

const isWrite = (action: ItemAction) =>
  action === 'create' || action === 'update';

/** Modules in the source language first, then other modules, then manuals. */
function writeOrder(write: PlannedWrite, source: string): number {
  if (write.subject.type === 'module') {
    return write.subject.lang === source ? 0 : 1;
  }
  return 2;
}

function compareWrites(a: PlannedWrite, b: PlannedWrite): number {
  const x = subjectName(a.subject);
  const y = subjectName(b.subject);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** What the asset route would refuse about a file: its type and its size, by the same rules. */
function fileRefusals(
  bytes: Uint8Array,
  usedAs: UploadKind,
  fileName: string | undefined,
  settings: PlanContext['settings'],
): ReportIssue[] {
  const refusals: ReportIssue[] = [];
  if (usedAs === 'image') {
    if (!acceptedUploadType(bytes.subarray(0, SNIFF_BYTES))) {
      refusals.push(
        issue(
          'error',
          'unsupported-image-type',
          'An image block shows it, but it is neither PNG nor JPEG (recognised by its bytes).',
        ),
      );
    }
    if (bytes.byteLength > settings.maxImageBytes) {
      refusals.push(
        issue(
          'error',
          'too-large',
          `An image is at most ${settings.maxImageBytes} bytes (CCMS_MAX_UPLOAD_BYTES).`,
        ),
      );
    }
  } else {
    const type = attachmentType(
      bytes.subarray(0, ATTACHMENT_SNIFF_BYTES),
      fileName,
    );
    const refused = refusal(type, settings.attachmentTypes);
    if (refused) {
      refusals.push(
        issue(
          'error',
          'unsupported-attachment-type',
          `An attachment of type ${type.mediaType} is refused by the server’s rules (${refused.reason}).`,
        ),
      );
    }
    if (bytes.byteLength > settings.maxAttachmentBytes) {
      refusals.push(
        issue(
          'error',
          'too-large',
          `An attachment is at most ${settings.maxAttachmentBytes} bytes (CCMS_MAX_ATTACHMENT_BYTES).`,
        ),
      );
    }
  }
  return refusals;
}

/** What a plan decided, item by item, to tell whether the target changed since it was checked. */
export function decisionsOf(report: ImportReport): string[] {
  return report.items.map(
    (item) => `${item.kind}:${item.lang ?? ''}:${item.id}:${item.action}`,
  );
}

/** The plan's writes in save points: each within `files` files and `bytes` of working copies. */
export function batches(
  writes: readonly PlannedWrite[],
  limits: { readonly files: number; readonly bytes: number },
): PlannedWrite[][] {
  const out: PlannedWrite[][] = [];
  let current: PlannedWrite[] = [];
  let size = 0;
  for (const write of writes) {
    if (
      current.length > 0 &&
      (current.length >= limits.files || size + write.bytes > limits.bytes)
    ) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(write);
    size += write.bytes;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Whether the target holds `content` already, as its file would be written
 * (AsciiDoc for a module, YAML for a manifest): equal printed forms, equal
 * files. One the target cannot read, or the actor reads only partly, is no
 * match, so it is updated as before.
 */
async function sameAsStored(
  snapshot: ReadableContent,
  subject: LockSubject,
  content: Module | Manifest,
): Promise<boolean> {
  try {
    if (subject.type === 'module' && 'blocks' in content) {
      const stored = await snapshot.module(subject.moduleId, subject.lang);
      return (
        stored !== undefined && printModule(stored) === printModule(content)
      );
    }
    if (subject.type === 'manual' && 'entries' in content) {
      const stored = await snapshot.manual(subject.manualId);
      return (
        stored !== undefined &&
        stored.issues.length === 0 &&
        printManifest(stored.manifest) === printManifest(content)
      );
    }
  } catch (error) {
    if (error instanceof DomainError) return false;
    throw error;
  }
  return false;
}

/**
 * `manifest` with the translation record its committed file at `snapshot` has, none when that
 * has none (#663): the import format carries no record (`ImportedManifest`), and only a
 * translation manager changes one.
 */
export async function withCommittedRecord(
  snapshot: ReadableContent,
  subject: SubjectOf<'manual'>,
  manifest: Manifest,
): Promise<Manifest> {
  const translations = (await recordAt(snapshot, subject))?.translations;
  const { translations: _given, ...rest } = manifest;
  return translations === undefined
    ? (rest as Manifest)
    : { ...rest, translations: translations as Manifest['translations'] };
}
