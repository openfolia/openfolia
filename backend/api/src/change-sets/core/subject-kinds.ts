import {
  AsciidocParseError,
  ConfigParseError,
  CURRENT_MANIFEST_VERSION,
  CURRENT_SCHEMA_VERSION,
  type Issue,
  StoredManifest,
  ManifestParseError,
  PAGE_DESIGN_SCHEMA_VERSION,
  PageDesign,
  PageDesignParseError,
  parsePageDesign,
  printPageDesign,
  Module,
  parseConfig,
  parseManifest,
  parseModule,
  parseTerm,
  printConfig,
  printManifest,
  printModule,
  printTerm,
  type ProjectConfig,
  StrictProjectConfig,
  Term,
  TERM_SCHEMA_VERSION,
  TermParseError,
  validateManifest,
  validateModule,
  validateTerm,
  withoutMovedSettings,
  CONFIG_FILE_NAME,
  designTemplateFilePath,
  isConfigFileName,
  utf8Length,
} from '@openfolia/content-model';
import { designIssues } from './design-issues.js';
import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import {
  allows,
  allowsManual,
  moduleTarget,
} from '../../access/core/allows.js';
import { UnprocessableError } from '../../base/core/errors.js';
import type {
  ReadableContent,
  ReadPermission,
} from '../../content/core/readable-content.js';
import {
  pastTemplateCaps,
  TEMPLATE_CAPS,
  templateFolderSize,
} from '../../content/core/template-caps.js';
import type { WorkingCopySize } from './working-copy-store.js';
import {
  type LockSubject,
  parseSubject,
  type SubjectOf,
  type SubjectType,
} from './lock.js';
import {
  checkCommittedScope,
  checkConfigChange,
  checkDesignChange,
  checkManualScope,
  checkModuleScope,
  checkTermChange,
  committedPageDesign,
  committedTerm,
  seesSubject,
} from './subject-scope.js';
import {
  DraftManifest,
  TEMPLATE_FILE_SCHEMA_VERSION,
  TemplateFileContent,
  type WorkingCopyContent,
  type WorkingCopyView,
} from './working-copy.js';

/** A working copy printed as its file, or why it cannot be one yet. */
export type Printed = { text: string } | { problem: string; code: string };

/** A committed file as a working copy reads it, with its validation issues. */
export interface Committed {
  readonly content: WorkingCopyContent;
  readonly issues: WorkingCopyView['issues'];
}

/**
 * Everything change sets need to know about one kind of subject: where its
 * file lives, what a working copy of it holds, how it is checked, printed
 * and read, and who may change it. Locks, working copies, save points and
 * the changes list ask the kind (`kindOf`), so a new kind of project file
 * is one entry of `SUBJECT_KINDS`, not a change across all of them.
 */
export interface SubjectKind<S extends LockSubject = LockSubject> {
  readonly type: S['type'];
  /**
   * The repository path of the subject's file, made from the subject key
   * alone (never from the content's own `id` or `meta.lang`).
   */
  path(subject: S): string;
  /** The subject whose file `path` is, in its canonical spelling only. */
  ofPath(path: string): S | undefined;
  /**
   * What a working copy holds, as a request sends it: the shape is checked
   * (unknown keys refused where the file format refuses them).
   */
  readonly content: z.ZodType<WorkingCopyContent>;
  /** The content's format version, as the database stores it with the copy. */
  readonly schemaVersion: number;
  /** The format version `content` claims (a working copy saved by an older model differs). */
  versionOf(content: WorkingCopyContent): number;
  /**
   * The content as the database stores it: a JSON object with its
   * `schemaVersion` (the database checks the column against it).
   */
  stored(content: WorkingCopyContent): { schemaVersion: number };
  /** Stored JSON read back through the current schema; `undefined` when it does not fit. */
  fromStored(json: unknown): WorkingCopyContent | undefined;
  /** Whether the content names the subject (its ID, a module's language); 422 otherwise. */
  names(subject: S, content: WorkingCopyContent): boolean;
  /** The 422 `subject-mismatch` detail. */
  mismatch(subject: S): string;
  /** The content's problems against the configuration (a draft may have some). */
  issues(
    subject: S,
    content: WorkingCopyContent,
    config: ProjectConfig,
  ): Issue[];
  /**
   * The working copy as its file, which must read back to itself
   * (`print(parse(text))` is `text`).
   */
  print(subject: S, content: WorkingCopyContent): Printed;
  /**
   * 403 unless `actor` may change the subject as committed in `snapshot`
   * and, with `content`, into `content` (one answer whatever the reason).
   */
  checkChange(
    actor: Actor,
    snapshot: ReadableContent,
    subject: S,
    content: WorkingCopyContent | undefined,
  ): Promise<void>;
  /**
   * Whether the subject's file exists in `snapshot` (read past the filter,
   * for a check): 422 `nothing-to-delete` otherwise. 422 `not-deletable`
   * for a kind that is never deleted.
   */
  exists(snapshot: ReadableContent, subject: S): Promise<boolean>;
  readonly deletable: boolean;
  /** Whether a lock on the subject, on the branch `snapshot`, is one `actor` may know of. */
  sees(
    actor: Actor,
    snapshot: ReadableContent,
    subject: S,
    permission: ReadPermission,
  ): Promise<boolean>;
  /** Whether `actor` may read a saved working copy (`permission` their draft-reading one). */
  showsCopy(
    actor: Actor,
    permission: ReadPermission,
    content: WorkingCopyContent,
    config: ProjectConfig,
  ): boolean;
  /** The committed file as the actor may read it in `snapshot`; `undefined`: none (or hidden). */
  committed(
    snapshot: ReadableContent,
    subject: S,
    config: ProjectConfig,
  ): Promise<Committed | undefined>;
}

/** A round trip through a printer and its parser: the text, or why it is no file. */
function roundTrip(
  print: () => string,
  reprint: (text: string) => string,
  what: string,
): Printed {
  try {
    const text = print();
    return reprint(text) === text
      ? { text }
      : {
          code: 'not-canonical',
          problem: `The ${what} does not print to a file that reads back the same.`,
        };
  } catch (error) {
    if (
      error instanceof AsciidocParseError ||
      error instanceof ManifestParseError ||
      error instanceof ConfigParseError ||
      error instanceof TermParseError ||
      error instanceof PageDesignParseError
    ) {
      return {
        code: 'not-canonical',
        problem: `The printed file does not read back: ${error.message}`,
      };
    }
    throw error;
  }
}

/** A path's subject, through its key, only when the path is its canonical one. */
function canonicalOf<S extends LockSubject>(
  name: string,
  path: string,
  pathOf: (subject: S) => string,
): S | undefined {
  const subject = parseSubject(name) as S | undefined;
  return subject && pathOf(subject) === path ? subject : undefined;
}

const MODULE_KIND: SubjectKind<SubjectOf<'module'>> = {
  type: 'module',
  path: (s) => `modules/${s.lang}/${s.moduleId}.adoc`,
  ofPath(path) {
    const match = /^modules\/([^/]+)\/([^/]+)\.adoc$/.exec(path);
    if (!match) return undefined;
    return canonicalOf(
      `module/${match[1] ?? ''}/${match[2] ?? ''}`,
      path,
      MODULE_KIND.path,
    );
  },
  content: Module,
  schemaVersion: CURRENT_SCHEMA_VERSION,
  versionOf: (content) => (content as Module).schemaVersion,
  stored: (content) => content as Module,
  fromStored: (json) => Module.safeParse(json).data,
  names: (s, content) =>
    'id' in content &&
    content.id === s.moduleId &&
    'meta' in content &&
    content.meta.lang === s.lang,
  mismatch: (s) =>
    `The content's \`id\` and \`meta.lang\` must name the module in the path (${s.lang}/${s.moduleId}).`,
  issues: (_s, content, config) => validateModule(content as Module, config),
  print: (s, content) =>
    roundTrip(
      () => printModule(content as Module),
      (text) => printModule(parseModule(text, { id: s.moduleId })),
      'module',
    ),
  checkChange: (actor, snapshot, s, content) =>
    content === undefined
      ? checkCommittedScope(actor, snapshot, s)
      : checkModuleScope(actor, snapshot, s, content as Module),
  exists: async (snapshot, s) =>
    (await snapshot.moduleMetaForCheck(s.moduleId, s.lang)) !== undefined,
  deletable: true,
  sees: (actor, snapshot, s, permission) =>
    seesSubject(actor, snapshot, s, permission),
  showsCopy: (actor, permission, content, config) =>
    allows(actor, permission, moduleTarget((content as Module).meta, config)),
  async committed(snapshot, s, config) {
    const module = await snapshot.module(s.moduleId, s.lang);
    return (
      module && { content: module, issues: validateModule(module, config) }
    );
  },
};

const MANUAL_KIND: SubjectKind<SubjectOf<'manual'>> = {
  type: 'manual',
  path: (s) => `manuals/${s.manualId}.yaml`,
  ofPath(path) {
    const match = /^manuals\/([^/]+)\.yaml$/.exec(path);
    if (!match) return undefined;
    return canonicalOf(`manual/${match[1] ?? ''}`, path, MANUAL_KIND.path);
  },
  content: DraftManifest,
  schemaVersion: CURRENT_MANIFEST_VERSION,
  versionOf: (content) => (content as DraftManifest).schemaVersion,
  stored: (content) => content as DraftManifest,
  fromStored: (json) => DraftManifest.safeParse(json).data,
  names: (s, content) =>
    'id' in content && content.id === s.manualId && 'entries' in content,
  mismatch: (s) =>
    `The content's \`id\` must name the manual in the path (${s.manualId}).`,
  // A draft may have no entries yet; nothing in validation needs one.
  issues: (_s, content, config) =>
    validateManifest(content as DraftManifest, config),
  print(s, content) {
    // As a file holds it: an assembled manual with an entry, a derived one with its rule (#451).
    const manifest = StoredManifest.safeParse(content as DraftManifest);
    if (!manifest.success) {
      return {
        code: 'not-a-manifest',
        problem: `The manifest cannot be stored yet: ${z.prettifyError(manifest.error)}`,
      };
    }
    return roundTrip(
      () => printManifest(manifest.data),
      (text) => printManifest(parseManifest(text, { id: s.manualId })),
      'manifest',
    );
  },
  checkChange: (actor, snapshot, s, content) =>
    content === undefined
      ? checkCommittedScope(actor, snapshot, s)
      : checkManualScope(actor, snapshot, s, content as DraftManifest),
  exists: async (snapshot, s) =>
    (await snapshot.manifestForCheck(s.manualId)) !== undefined,
  deletable: true,
  sees: (actor, snapshot, s, permission) =>
    seesSubject(actor, snapshot, s, permission),
  showsCopy: (actor, permission, content, config) =>
    allowsManual(actor, permission, {
      audiences: config.audiences.map((a) => a.id),
      audience: (content as DraftManifest).audience,
      lang: undefined,
    }),
  async committed(snapshot, s) {
    const manual = await snapshot.manual(s.manualId);
    return manual && { content: manual.manifest, issues: manual.issues };
  },
};

/**
 * The format version a configuration working copy is stored with: the
 * file has none of its own (`openfolia.yaml` is not versioned), the database
 * row needs one.
 */
export const CONFIG_SCHEMA_VERSION = 1;

/**
 * The configuration's path in the repository, where its changes are written. A repository that
 * still has only `ccms.yaml` (`LEGACY_CONFIG_FILE_NAME`, read for one release) gets
 * `openfolia.yaml` with the first change, which then wins.
 */
export const CONFIG_FILE = CONFIG_FILE_NAME;

const CONFIG_KIND: SubjectKind<SubjectOf<'config'>> = {
  type: 'config',
  path: () => CONFIG_FILE,
  ofPath: (path) => (isConfigFileName(path) ? { type: 'config' } : undefined),
  content: StrictProjectConfig,
  schemaVersion: CONFIG_SCHEMA_VERSION,
  versionOf: () => CONFIG_SCHEMA_VERSION,
  stored: (content) => ({
    ...(content as ProjectConfig),
    schemaVersion: CONFIG_SCHEMA_VERSION,
  }),
  fromStored(json) {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      return undefined;
    }
    const { schemaVersion, ...config } = json as Record<string, unknown>;
    if (schemaVersion !== CONFIG_SCHEMA_VERSION) return undefined;
    return StrictProjectConfig.safeParse(config).data;
  },
  names: () => true,
  mismatch: () => 'The configuration names no subject.',
  // Its shape is its validity; what it would break is checked apart
  // (`configUsages`), against the content of the branch.
  issues: () => [],
  print: (_s, content) =>
    roundTrip(
      () => printConfig(content as ProjectConfig),
      (text) => printConfig(parseConfig(text)),
      'configuration',
    ),
  checkChange: async (actor) => checkConfigChange(actor),
  exists: () => Promise.resolve(true),
  deletable: false,
  // Every reader of the branch reads the configuration.
  sees: () => Promise.resolve(true),
  showsCopy: () => true,
  async committed(snapshot) {
    return { content: await snapshot.config(), issues: [] };
  },
};

const TERM_KIND: SubjectKind<SubjectOf<'term'>> = {
  type: 'term',
  path: (s) => `terms/${s.termId}.yaml`,
  ofPath(path) {
    const match = /^terms\/([^/]+)\.yaml$/.exec(path);
    if (!match) return undefined;
    return canonicalOf(`term/${match[1] ?? ''}`, path, TERM_KIND.path);
  },
  content: Term,
  schemaVersion: TERM_SCHEMA_VERSION,
  versionOf: (content) => (content as Term).schemaVersion,
  stored: (content) => content as Term,
  fromStored: (json) => Term.safeParse(json).data,
  names: (s, content) =>
    'id' in content && content.id === s.termId && 'status' in content,
  mismatch: (s) =>
    `The content's \`id\` must name the term in the path (${s.termId}).`,
  issues: (_s, content, config) => validateTerm(content as Term, config),
  print: (s, content) =>
    roundTrip(
      () => printTerm(content as Term),
      (text) => printTerm(parseTerm(text, { id: s.termId })),
      'term',
    ),
  checkChange: (actor, snapshot, s, content) =>
    checkTermChange(actor, snapshot, s, content as Term | undefined),
  exists: async (snapshot, s) =>
    (await snapshot.termSource(s.termId)) !== undefined,
  deletable: true,
  // Terms carry no audience: every reader of the branch reads them (#135).
  sees: () => Promise.resolve(true),
  showsCopy: () => true,
  async committed(snapshot, s, config) {
    const term = await committedTerm(snapshot, s.termId);
    // A file that is no term reads as none: its author saves a new one.
    if (term === undefined || term === 'unreadable') return undefined;
    return { content: term, issues: validateTerm(term, config) };
  },
};

/**
 * A page design (#390), `design/<id>.yaml`: read by every reader of the
 * branch (it carries no audience, and every language's text), changed only
 * by an actor whose `content.edit` role restricts nothing
 * (`checkDesignChange`), reviewed as a file outside every module's scope.
 * Its issues are `validatePageDesign`'s (`designIssues`).
 */
const DESIGN_KIND: SubjectKind<SubjectOf<'design'>> = {
  type: 'design',
  path: (s) => `design/${s.designId}.yaml`,
  ofPath(path) {
    const match = /^design\/([^/]+)\.yaml$/.exec(path);
    if (!match) return undefined;
    return canonicalOf(`design/${match[1] ?? ''}`, path, DESIGN_KIND.path);
  },
  content: PageDesign,
  schemaVersion: PAGE_DESIGN_SCHEMA_VERSION,
  versionOf: (content) => (content as PageDesign).schemaVersion,
  stored: (content) => content as PageDesign,
  // A working copy saved before a setting moved out of designs (#395) still reads.
  fromStored: (json) => PageDesign.safeParse(withoutMovedSettings(json)).data,
  names: (s, content) =>
    'id' in content && content.id === s.designId && 'preset' in content,
  mismatch: (s) =>
    `The content's \`id\` must name the page design in the path (${s.designId}).`,
  issues: (_s, content, config) => designIssues(content as PageDesign, config),
  print: (s, content) =>
    roundTrip(
      () => printPageDesign(content as PageDesign),
      (text) => printPageDesign(parsePageDesign(text, { id: s.designId })),
      'page design',
    ),
  checkChange: async (actor) => checkDesignChange(actor),
  exists: async (snapshot, s) =>
    (await snapshot.pageDesignSource(s.designId)) !== undefined,
  deletable: true,
  // Page designs carry no audience: every reader of the branch reads them.
  sees: () => Promise.resolve(true),
  showsCopy: () => true,
  async committed(snapshot, s, config) {
    const design = await committedPageDesign(snapshot, s.designId);
    // A file that is no design reads as none: its author saves a new one.
    if (design === undefined || design === 'unreadable') return undefined;
    return {
      content: design,
      issues: designIssues(design, config),
    };
  },
};

/** A template file's committed bytes as text; undefined for bytes that are no UTF-8 text. */
function textOf(data: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * 422 `path-conflict` when the file's path cannot be a file in its template's folder at the
 * branch: a folder there has its name, or one of its folders is a file there. Git holds no file
 * and folder of one name, so such a save would fail only at the save point. Checked when a
 * working copy is saved only: a commit or a carried change may delete the clashing file in the
 * same step, and the Git writer refuses a real clash there (422 `path-conflict`).
 */
export async function refuseFolderClash(
  snapshot: ReadableContent,
  s: SubjectOf<'template'>,
): Promise<void> {
  const listed = await snapshot.designTemplateListing(s.templateId);
  const clash = listed.find(
    (f) => f.path.startsWith(`${s.path}/`) || s.path.startsWith(`${f.path}/`),
  );
  if (clash) {
    throw new UnprocessableError(
      'path-conflict',
      `"${s.path}" cannot be a file of the template: "${clash.path}" is in its way (a file and a folder of one name).`,
    );
  }
}

/**
 * 422 `template-too-large` (#803) when saving `text` as the working copy of the template file
 * `s` would take its folder past `MAX_TEMPLATE_FILES` or `MAX_TEMPLATE_BYTES`: the files
 * `listed` at the branch, each drafted one at its draft's length (`copies`, the change set's
 * working copies), each draft no file has counted as one more, and this one in place of the
 * draft or file it replaces. A save that adds neither a file nor bytes is kept, so a folder past
 * the caps already can still be made smaller. Nothing is read.
 */
export function refuseTemplatePastCaps(
  listed: readonly { readonly path: string; readonly size: number }[],
  copies: readonly WorkingCopySize[],
  s: SubjectOf<'template'>,
  text: string,
): void {
  const drafts = new Map<string, number>();
  for (const { subject, textBytes } of copies) {
    if (subject.type === 'template' && subject.templateId === s.templateId) {
      drafts.set(subject.path, textBytes ?? 0);
    }
  }
  const before = templateFolderSize(listed, drafts);
  const after = templateFolderSize(
    listed,
    new Map(drafts).set(s.path, utf8Length(text)),
  );
  if (!pastTemplateCaps(after)) return;
  if (after.files <= before.files && after.bytes <= before.bytes) return;
  throw new UnprocessableError(
    'template-too-large',
    `The template would hold ${after.files} files and ${after.bytes} bytes; at most ${TEMPLATE_CAPS.maxFiles} files and ${TEMPLATE_CAPS.maxBytes} bytes.`,
    { ...TEMPLATE_CAPS, files: after.files, bytes: after.bytes },
  );
}

/**
 * A text file of a page design's own template (#396), `templates/<templateId>/<path>`: read by
 * every reader of the branch (templates carry no audience, as designs), changed only by an actor
 * who may change page designs (`checkDesignChange`: `content.edit` through a role whose scope
 * restricts nothing), since a template lays out every manual whose design names it. The working
 * copy is the file's text, written as it is; whether the template compiles is the change set's
 * check (`page-design-template-error`) and the template screen's preview, not a save's.
 */
const TEMPLATE_KIND: SubjectKind<SubjectOf<'template'>> = {
  type: 'template',
  path: (s) => designTemplateFilePath(s.templateId, s.path),
  ofPath(path) {
    const match = /^templates\/([^/]+)\/(.+)$/.exec(path);
    if (!match) return undefined;
    return canonicalOf(
      `template/${match[1] ?? ''}/${match[2] ?? ''}`,
      path,
      TEMPLATE_KIND.path,
    );
  },
  content: TemplateFileContent,
  schemaVersion: TEMPLATE_FILE_SCHEMA_VERSION,
  versionOf: (content) => (content as TemplateFileContent).schemaVersion,
  stored: (content) => content as TemplateFileContent,
  fromStored: (json) => TemplateFileContent.safeParse(json).data,
  // The path names the file; its text names nothing.
  names: (_s, content) => 'text' in content && !('id' in content),
  mismatch: () => 'The content of a template file is its `text`.',
  issues: () => [],
  print: (_s, content) => ({ text: (content as TemplateFileContent).text }),
  checkChange: async (actor) => checkDesignChange(actor),
  exists: async (snapshot, s) =>
    (await snapshot.designTemplateFile(s.templateId, s.path)) !== undefined,
  deletable: true,
  // Templates carry no audience: every reader of the branch reads them.
  sees: () => Promise.resolve(true),
  showsCopy: () => true,
  async committed(snapshot, s) {
    const data = await snapshot.designTemplateFile(s.templateId, s.path);
    const text = data === undefined ? undefined : textOf(data);
    // A file that is no text reads as none: the editor shows no bytes as text.
    if (text === undefined) return undefined;
    return {
      content: { schemaVersion: TEMPLATE_FILE_SCHEMA_VERSION, text },
      issues: [],
    };
  },
};

/** Every kind of subject change sets edit, by type. */
export const SUBJECT_KINDS: {
  readonly [T in SubjectType]: SubjectKind<SubjectOf<T>>;
} = {
  module: MODULE_KIND,
  manual: MANUAL_KIND,
  config: CONFIG_KIND,
  term: TERM_KIND,
  design: DESIGN_KIND,
  template: TEMPLATE_KIND,
};

/** The kind of `subject`, typed for it. */
export function kindOf<S extends LockSubject>(subject: S): SubjectKind<S> {
  return SUBJECT_KINDS[subject.type] as unknown as SubjectKind<S>;
}

/** The kind of a type, for any subject of it. */
export function kindOfType(type: SubjectType): SubjectKind {
  return SUBJECT_KINDS[type] as unknown as SubjectKind;
}

/** The subject a repository path is the file of; undefined for any other file. */
export function subjectOfPath(path: string): LockSubject | undefined {
  for (const kind of Object.values(SUBJECT_KINDS) as SubjectKind[]) {
    const subject = kind.ofPath(path);
    if (subject) return subject;
  }
  return undefined;
}

/** 422 `not-deletable` for a kind that is never deleted, `nothing-to-delete` for no file. */
export async function checkDeletable(
  actor: Actor,
  head: ReadableContent,
  subject: LockSubject,
  name: string,
): Promise<void> {
  const kind = kindOf(subject);
  if (!kind.deletable) {
    throw new UnprocessableError(
      'not-deletable',
      `${name} cannot be deleted.`,
      { subject },
    );
  }
  await kind.checkChange(actor, head, subject, undefined);
  if (!(await kind.exists(head, subject))) {
    throw new UnprocessableError(
      'nothing-to-delete',
      `There is no ${name} on the branch to delete.`,
      { subject },
    );
  }
}

/** 422 `subject-mismatch` unless the content is the subject's (its ID; a module's language too). */
export function checkSubject(
  subject: LockSubject,
  content: WorkingCopyContent,
): void {
  const kind = kindOf(subject);
  if (!kind.names(subject, content)) {
    throw new UnprocessableError('subject-mismatch', kind.mismatch(subject));
  }
}
