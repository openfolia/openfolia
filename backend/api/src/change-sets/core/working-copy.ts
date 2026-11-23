import {
  Manifest,
  ManifestEntry,
  MAX_TEMPLATE_FILE_BYTES,
  utf8Length,
  type Module,
  type Issue,
  type ProjectConfig,
  type PageDesign,
  type Term,
} from '@openfolia/content-model';
import { z } from 'zod';
import type { ChangeSetAuthor } from './change-set.js';
import type { LockSubject } from './lock.js';

/**
 * A manifest as a working copy holds it: a draft may have no entries yet
 * (a stored manifest needs one); everything else as `Manifest`.
 */
export const DraftManifest = Manifest.extend({
  entries: z.array(ManifestEntry),
}).meta({ id: 'DraftManifest' });
export type DraftManifest = z.output<typeof DraftManifest>;

/** The format version of a template file's working copy (#396): the file is text, unversioned. */
export const TEMPLATE_FILE_SCHEMA_VERSION = 1;

/**
 * A text file of a page design's own template as a working copy holds it (#396): its text, as
 * the file will hold it, at most `MAX_TEMPLATE_FILE_BYTES` as UTF-8, without NUL characters
 * (a text file; the editor shows it as text).
 */
export const TemplateFileContent = z
  .strictObject({
    schemaVersion: z.literal(TEMPLATE_FILE_SCHEMA_VERSION),
    text: z
      .string()
      .max(MAX_TEMPLATE_FILE_BYTES)
      .refine((text) => utf8Length(text) <= MAX_TEMPLATE_FILE_BYTES, {
        message: `at most ${MAX_TEMPLATE_FILE_BYTES} bytes as UTF-8`,
      })
      .refine((text) => !text.includes('\0'), {
        message: 'a text file: no NUL characters',
      }),
  })
  .meta({ id: 'TemplateFileContent' });
export type TemplateFileContent = z.output<typeof TemplateFileContent>;

/**
 * What a working copy holds: a module's tree, a manual's manifest, the
 * configuration, a term, a page design or a template file's text
 * (`SUBJECT_KINDS` says which for each subject).
 */
export type WorkingCopyContent =
  | Module
  | DraftManifest
  | ProjectConfig
  | Term
  | PageDesign
  | TemplateFileContent;

/** Who saved a working copy last, as the audit log names actors. */
export type WorkingCopyEditor = ChangeSetAuthor;

/**
 * The content of one module or manual being edited in a change set, saved
 * by the editor every few seconds (autosave), in Postgres: nothing is
 * committed to Git until a save point. One per change set and subject.
 * `version` counts the saves (1 for the first): a save names the version
 * it was based on, so a stale one is refused instead of overwriting.
 */
export interface WorkingCopy {
  readonly changeSetId: string;
  readonly subject: LockSubject;
  /** A `Module` for a module, a `DraftManifest` for a manual, a `ProjectConfig`, a `Term`. */
  readonly content: WorkingCopyContent;
  /**
   * The branch commit whose file the content is based on: the branch head
   * when it was saved, or the commit the editor read when the file has not
   * changed since (see `SaveWorkingCopyAction`).
   */
  readonly baseCommit: string;
  readonly version: number;
  readonly updatedBy: WorkingCopyEditor;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A save, as the store writes it; the store numbers and stamps it. */
export interface WorkingCopyWrite {
  readonly changeSetId: string;
  readonly subject: LockSubject;
  readonly content: WorkingCopyContent;
  /** The commit the content is based on; every save stores it. */
  readonly baseCommit: string;
  readonly updatedBy: WorkingCopyEditor;
}

/** A working copy, or the committed file read in its place, with its issues. */
export interface WorkingCopyView {
  readonly changeSetId: string;
  readonly subject: LockSubject;
  readonly content: WorkingCopyContent;
  /** The working copy's; for the committed file, the commit it was read at. */
  readonly baseCommit: string;
  /** 0 when nothing is saved: the content is the committed file. */
  readonly version: number;
  readonly updatedBy?: WorkingCopyEditor;
  readonly updatedAt?: Date;
  readonly issues: readonly (
    Issue | { severity: 'warning'; code: string; message: string; at: string }
  )[];
}

/**
 * The largest working copy, as UTF-8 JSON. Request bodies are at most
 * 1 MB anyway; a module this size is far past any real one.
 */
export const MAX_WORKING_COPY_BYTES = 512 * 1024;

/** The size of `content` as the database stores it (UTF-8 JSON). */
export const workingCopyBytes = (content: object): number =>
  new TextEncoder().encode(JSON.stringify(content)).length;

/**
 * The most working copies one change set holds. A working copy outlives
 * its lock (releasing one keeps it), so the lock limit alone does not
 * bound them.
 */
export const MAX_WORKING_COPIES_PER_CHANGE_SET = 1000;
