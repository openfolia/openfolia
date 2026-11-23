import {
  DesignTemplateFilePath,
  DesignTemplateId,
  LanguageTag,
  ModuleId,
  PageDesignId,
  TermId,
} from '@openfolia/content-model';
import { z } from 'zod';
import type { ChangeSetAuthor } from './change-set.js';
import { isChangeSetId, newChangeSetId } from './change-set.js';

/**
 * A module's language as a lock (and a working copy) names it. A tag of
 * any length is valid BCP 47; a lock's key is at most 200. Its canonical
 * form must still be language and subtags (the database's format):
 * `en-US-POSIX` canonicalizes to an extension.
 */
export const SubjectLanguage = z
  .string()
  .max(35)
  .pipe(LanguageTag)
  .pipe(
    z
      .string()
      .regex(
        /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/,
        'a language with subtags of 2 to 8 characters, e.g. "en" or "pt-BR"',
      ),
  );

/**
 * The configuration's only subject ID. Compatibility: it keeps the configuration file's name from
 * before the product was named (`ccms.yaml`), as it is stored (locks, working copies, refresh
 * conflicts, whose check constraints hold it) and recorded in the audit log; the file itself is
 * `openfolia.yaml` (`CONFIG_FILE_NAME`).
 */
export const CONFIG_SUBJECT_ID = 'ccms.yaml';

/**
 * What a lock is on: a module in one language, a manual (its manifest),
 * the configuration (`openfolia.yaml`), a term (`terms/<id>.yaml`), a page
 * design (`design/<id>.yaml`, #390) or a text file of a page design's own
 * template (`templates/<id>/<path>`, #396). It need
 * not exist yet: a change set locks a new module's ID to create it. Every
 * kind's rules are one entry of `SUBJECT_KINDS` (`subject-kinds.ts`).
 */
const ModuleSubject = z.strictObject({
  type: z.literal('module'),
  lang: SubjectLanguage,
  moduleId: ModuleId,
});
const ManualSubject = z.strictObject({
  type: z.literal('manual'),
  manualId: ModuleId,
});

const DesignSubject = z.strictObject({
  type: z.literal('design'),
  designId: PageDesignId,
});

/**
 * A module (in one language), a manual or a page design (its own template, #396): what content
 * checks are about.
 */
export const ContentSubject = z.discriminatedUnion('type', [
  ModuleSubject,
  ManualSubject,
  DesignSubject,
]);
export type ContentSubject = z.output<typeof ContentSubject>;

/**
 * A text file of a page design's own template (#396): `templates/<templateId>/<path>`, `path`
 * its place in the folder (`manual.typ`, `parts/notice.typ`). Each file is a subject of its own:
 * locked, saved and committed on its own, like a module.
 */
const TemplateFileSubject = z
  .strictObject({
    type: z.literal('template'),
    templateId: DesignTemplateId,
    path: DesignTemplateFilePath,
  })
  // Stored as `<templateId>/<path>`, which the tables hold to 200 characters.
  .refine((s) => s.templateId.length + 1 + s.path.length <= 200, {
    message:
      'The template ID and the path are at most 199 characters together.',
    path: ['path'],
  });

export const LockSubject = z.discriminatedUnion('type', [
  ModuleSubject,
  ManualSubject,
  z.strictObject({ type: z.literal('config') }),
  z.strictObject({ type: z.literal('term'), termId: TermId }),
  DesignSubject,
  TemplateFileSubject,
]);
export type LockSubject = z.output<typeof LockSubject>;
export type SubjectType = LockSubject['type'];
export type SubjectOf<T extends SubjectType> = Extract<
  LockSubject,
  { type: T }
>;

/** The kinds of subject, as the audit log names them. */
export const LOCK_SUBJECT_TYPES = [
  'module',
  'manual',
  'config',
  'term',
  'design',
  'template',
] as const;

/**
 * A subject as the audit log names it, and as it is stored: `module` with
 * `<lang>/<moduleId>`, `manual` with `<manualId>`, `config` with
 * `ccms.yaml` (`CONFIG_SUBJECT_ID`), `term` with `<termId>`, `design` with `<designId>`, `template`
 * with `<templateId>/<path>`. One key per subject: the language
 * is in its canonical case (`LanguageTag`).
 */
export function subjectKey(subject: LockSubject): {
  type: SubjectType;
  id: string;
} {
  switch (subject.type) {
    case 'module':
      return { type: 'module', id: `${subject.lang}/${subject.moduleId}` };
    case 'manual':
      return { type: 'manual', id: subject.manualId };
    case 'config':
      return { type: 'config', id: CONFIG_SUBJECT_ID };
    case 'term':
      return { type: 'term', id: subject.termId };
    case 'design':
      return { type: 'design', id: subject.designId };
    case 'template':
      return {
        type: 'template',
        id: `${subject.templateId}/${subject.path}`,
      };
  }
}

/** The subject stored as `subjectKey` gives it; undefined for anything else. */
export function subjectOfKey(key: {
  type: string;
  id: string;
}): LockSubject | undefined {
  const parts = key.id.split('/');
  const slash = key.id.indexOf('/');
  const candidate =
    key.type === 'module' && parts.length === 2
      ? { type: key.type, lang: parts[0], moduleId: parts[1] }
      : key.type === 'manual'
        ? { type: key.type, manualId: key.id }
        : key.type === 'config' && key.id === CONFIG_SUBJECT_ID
          ? { type: key.type }
          : key.type === 'term'
            ? { type: key.type, termId: key.id }
            : key.type === 'design'
              ? { type: key.type, designId: key.id }
              : key.type === 'template' && slash > 0
                ? {
                    type: key.type,
                    templateId: key.id.slice(0, slash),
                    path: key.id.slice(slash + 1),
                  }
                : undefined;
  const parsed = LockSubject.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A subject's name in the API (`filter[subject]`, a change's ID):
 * `module/<lang>/<moduleId>`, `manual/<manualId>`, `config`,
 * `term/<termId>`, `design/<designId>` or `template/<templateId>/<path>`.
 */
export function subjectName(subject: LockSubject): string {
  if (subject.type === 'config') return 'config';
  const { type, id } = subjectKey(subject);
  return `${type}/${id}`;
}

/**
 * The subject a name (`subjectName`) names (`module/en/battery-charging`,
 * `manual/operating`, `config`, `term/battery`); undefined for anything
 * else.
 */
export function parseSubject(text: string): LockSubject | undefined {
  if (text === 'config') return { type: 'config' };
  const slash = text.indexOf('/');
  if (slash < 0) return undefined;
  const type = text.slice(0, slash);
  if (type === 'config') return undefined;
  return subjectOfKey({ type, id: text.slice(slash + 1) });
}

/** Who holds a lock: the actor that took it, as the audit log names it. */
export type LockHolder = ChangeSetAuthor;

/**
 * A lock: while it exists, only its change set may change its subject.
 * One per subject (the database holds it); it lasts while its change set
 * is open (no expiry), until released, broken by an admin, or its change
 * set is abandoned (and, once they exist, approved or merged).
 */
export interface Lock {
  /** A UUID version 7, made by the server for each lock taken. */
  readonly id: string;
  readonly subject: LockSubject;
  readonly changeSetId: string;
  readonly holder: LockHolder;
  /** When it was taken (the taking transaction's time). */
  readonly since: Date;
}

/** A lock about to be taken: the database stamps `since`. */
export type NewLock = Omit<Lock, 'since'>;

/** Which locks to list; every field optional. */
export interface LockFilter {
  /** The holder's ID (user and service IDs never look alike). */
  readonly holder?: string;
  readonly changeSetId?: string;
  readonly subject?: LockSubject;
  /**
   * Only module locks in these languages, and every other lock: a first
   * cut by a reader's languages, before their content is checked.
   */
  readonly moduleLanguages?: readonly string[];
}

/** A lock's ID has a change set's format: a UUID version 7. */
export const newLockId = newChangeSetId;
export const isLockId = isChangeSetId;

/**
 * The most locks one holder may hold at once, across all their change
 * sets, so nobody can lock everything.
 */
export const MAX_LOCKS_PER_HOLDER = 1000;
