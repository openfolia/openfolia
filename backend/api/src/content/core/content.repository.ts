import type {
  Manifest,
  Module,
  ProjectConfig,
  ResolveResult,
  Term,
  PageDesign,
  PageDesignResolveIssue,
  ResolvedPageDesign,
  TranslationRecord,
  VariantValues,
} from '@openfolia/content-model';

export interface ModuleFile {
  id: string;
  lang: string;
}

/** A module's text in place of its file, or `undefined`: the file. */
export type ModuleStandIn = (
  id: string,
  lang: string,
) => Promise<Module | undefined>;

export interface RefInfo {
  name: string;
  /** The commit it points to (tags are peeled). */
  commit: string;
}

/** A commit on a first-parent line that changed a module's file (or a manifest, `manifestHistory`). */
export interface ModuleFileVersion {
  readonly commit: string;
  /** How many parents it has: 2 or more for a merge. */
  readonly parents: number;
  /** When it was committed (ISO 8601). */
  readonly committedAt: string;
  /** Its message without the trailers paragraph. */
  readonly message: string;
  /** Its trailers, in order: what the commit says about itself. */
  readonly trailers: readonly { key: string; value: string }[];
  /** The file's revision after it; undefined when it deleted the file. */
  readonly revision?: string;
}

/** The versions of a module's file (or a manifest) on a first-parent line, newest first. */
export interface ModuleFileHistory {
  readonly versions: readonly ModuleFileVersion[];
  /** Whether the line goes on past the commits looked at. */
  readonly truncated: boolean;
  /** When truncated: the file's revision just before the oldest commit looked at, if it had one. */
  readonly before?: string;
}

/** A module file deleted on a first-parent line and not there at its end. */
export interface DeletedModuleFile {
  readonly id: string;
  readonly lang: string;
  /** The file's revision before its newest deletion: the module as it last was. */
  readonly revision: string;
  /** The commit of that deletion. */
  readonly commit: string;
  /** When it was committed (ISO 8601). */
  readonly committedAt: string;
}

/** A manifest deleted on a first-parent line and not there at its end. */
export interface DeletedManifestFile {
  readonly id: string;
  /** The file's revision before its newest deletion: the manifest as it last was. */
  readonly revision: string;
  /** The commit of that deletion. */
  readonly commit: string;
  /** When it was committed (ISO 8601). */
  readonly committedAt: string;
}

/** The manifests deleted on a first-parent line, newest deletion first. */
export interface DeletedManifestFiles {
  readonly files: readonly DeletedManifestFile[];
  /** Whether the line goes on past the commits looked at. */
  readonly truncated: boolean;
}

/** The module files deleted on a first-parent line, newest deletion first. */
export interface DeletedModuleFiles {
  readonly files: readonly DeletedModuleFile[];
  /** Whether the line goes on past the commits looked at. */
  readonly truncated: boolean;
}

export interface ManualResolution extends ResolveResult {
  config: ProjectConfig;
  manifest: Manifest;
  /**
   * The manual's page design (#391), resolved for its variant and language: the one its
   * manifest names, else the configuration's `pdf.design`. None for the built-in design (and
   * for a design that does not exist, reported in `designIssues`): the PDF is the default one.
   */
  design?: ResolvedPageDesign;
  /** What resolving the design found (`unknown-page-design`, `missing-translation`, …). */
  designIssues?: readonly PageDesignResolveIssue[];
}

/**
 * The content at one commit, unfiltered. Reads return `undefined` when a
 * file does not exist and throw `InvalidContentError` when it cannot be
 * parsed. Only `OpenSnapshotAction` holds one: actions read through
 * `ReadableContent`, which filters every read by the actor's scope.
 */
export interface ContentSnapshot {
  readonly commit: string;
  config(): Promise<ProjectConfig>;
  modules(lang?: string): Promise<ModuleFile[]>;
  module(id: string, lang: string): Promise<Module | undefined>;
  /**
   * An ID of the module's file as stored (its Git blob), or undefined when
   * there is none: equal IDs, equal files, at any commits.
   */
  moduleRevision(id: string, lang: string): Promise<string | undefined>;
  /**
   * The versions of a module's file on this commit's first-parent line:
   * the commits among the newest `max` that changed it (a merge counting
   * when it brought a change in), newest first.
   */
  moduleHistory(
    id: string,
    lang: string,
    max: number,
  ): Promise<ModuleFileHistory>;
  /**
   * The module files deleted among the newest `max` commits of this
   * commit's first-parent line (a merge counting when it brought a
   * deletion in) and not there at this commit, each with its revision
   * before its newest deletion; newest deletion first.
   */
  deletedModules(max: number): Promise<DeletedModuleFiles>;
  /**
   * The module as stored in a file revision of it (from `moduleRevision`,
   * `moduleHistory` or `deletedModules`); undefined when there is no such revision. Throws
   * `InvalidContentError` when it cannot be read. It reads any blob of
   * the repository, whatever ref holds it: a revision passed in must come
   * from those, never from a request.
   */
  moduleAtRevision(
    id: string,
    lang: string,
    revision: string,
  ): Promise<Module | undefined>;
  /**
   * The translation record next to a module's file in a target language
   * (`modules/<lang>/<id>.translation.yaml`), or undefined when there is
   * none; one that cannot be parsed throws `InvalidContentError`.
   */
  translationRecord(
    id: string,
    lang: string,
  ): Promise<TranslationRecord | undefined>;
  manifests(): Promise<string[]>;
  /** The IDs of the terms (`terms/<id>.yaml`), sorted. */
  terms(): Promise<string[]>;
  /**
   * A term (`terms/<id>.yaml`), or undefined when there is none (or the ID
   * is no term ID); a file that is no term throws `InvalidContentError`.
   */
  term(id: string): Promise<Term | undefined>;
  /** The IDs of the page designs (`design/<id>.yaml`, #390), sorted. */
  pageDesigns(): Promise<string[]>;
  /**
   * A page design (`design/<id>.yaml`), or undefined when there is none (or
   * the ID is no design ID); a file that is no design throws
   * `InvalidContentError`.
   */
  pageDesign(id: string): Promise<PageDesign | undefined>;
  manifest(id: string): Promise<Manifest | undefined>;
  /**
   * An ID of the manifest's file as stored (`manuals/<id>.yaml`, its Git
   * blob), or undefined when there is none: equal IDs, equal files.
   */
  manifestRevision(id: string): Promise<string | undefined>;
  /** The versions of a manifest's file on this commit's first-parent line, as `moduleHistory`. */
  manifestHistory(id: string, max: number): Promise<ModuleFileHistory>;
  /** The manifests deleted on this commit's first-parent line, as `deletedModules`. */
  deletedManifests(max: number): Promise<DeletedManifestFiles>;
  /**
   * The manifest as stored in a file revision of it (from
   * `manifestRevision`, `manifestHistory` or `deletedManifests`), as
   * `moduleAtRevision`: never a revision from a request.
   */
  manifestAtRevision(
    id: string,
    revision: string,
  ): Promise<Manifest | undefined>;
  /**
   * Loads every module `manifest` needs and resolves it; modules that cannot
   * be read are reported as issues rather than thrown. Modules `visible`
   * refuses are left out (an `outside-scope` issue each), and their module
   * references are not followed. `manifest` is resolved as given (not read
   * again): a manifest of this commit, possibly with entries left out; an
   * entry left out is not evaluated at all (nor its condition).
   * `standIn` gives a module's text in place of its file (a working copy
   * not committed yet); `undefined` from it: the file.
   */
  resolve(
    manifest: Manifest,
    variant: VariantValues,
    lang: string,
    visible: (module: Module) => boolean,
    standIn?: ModuleStandIn,
  ): Promise<ManualResolution | undefined>;
  asset(hash: string): Promise<Uint8Array | undefined>;
  /**
   * Whether `asset(hash)` would find the file now, without reading it: an upload can store a
   * file a commit already names (a page design's logo, #552).
   */
  hasAsset(hash: string): Promise<boolean>;
  /** Safety symbol ID → repository path of its image. */
  symbols(): Promise<Map<string, string>>;
  file(path: string): Promise<Uint8Array | undefined>;
  /** The repository's own PDF template, if it has one. */
  template(): Promise<string | undefined>;
  /**
   * A page design's own template (#396): the files of `templates/<id>/` by their path in it,
   * undefined when it has no `manual.typ`; `InvalidContentError` for a folder past the content
   * model's `MAX_TEMPLATE_FILES` or `MAX_TEMPLATE_BYTES`.
   */
  designTemplate(id: string): Promise<Record<string, Uint8Array> | undefined>;
  /** The page design templates there are (#396): their IDs, sorted. */
  designTemplateIds(): Promise<readonly string[]>;
  /**
   * A page design template's folder as the editor lists it (#396): its regular files by path in
   * it, with their size and, read through an overlay, whether a working copy stands in for one
   * (`draft`), sorted by path; none for a folder that is not there. Nothing is read.
   */
  designTemplateListing(id: string): Promise<readonly TemplateFileEntry[]>;
  /**
   * One regular file of a template's folder by its path in it (a working copy's text in its
   * place, read through an overlay); undefined: none.
   */
  designTemplateFile(id: string, path: string): Promise<Uint8Array | undefined>;
  /**
   * What the template's files are beyond the commit: empty from the commit alone; an overlay's
   * hash of the working copies standing in for them (a rendering key carries it).
   */
  designTemplateRevision(id: string): Promise<string>;
  /**
   * When the commit was made, in whole seconds since the epoch (its
   * committer date): the date a PDF of it carries, so the same commit
   * always renders the same bytes (#328).
   */
  committedAt(): Promise<number>;
}

/**
 * What the PDF renderer may read: a template, symbols and images; of the page design templates
 * only the one the manual's design names (`designTemplate`, #396).
 */
export type RenderSource = Pick<
  ContentSnapshot,
  | 'commit'
  | 'symbols'
  | 'template'
  | 'asset'
  | 'hasAsset'
  | 'file'
  | 'committedAt'
> & {
  /** The files of the template the manual's page design names; undefined: none, or no such template. */
  designTemplate(): Promise<Record<string, Uint8Array> | undefined>;
};

/** A file of a page design template's folder (#396), as `designTemplateListing` lists it. */
export interface TemplateFileEntry {
  /** Its path in the folder: `manual.typ`, `parts/notice.typ`. */
  readonly path: string;
  /** Its size in bytes (a working copy's: its text's, as UTF-8). */
  readonly size: number;
  /** Whether a working copy of the change set stands in for it (only read through an overlay). */
  readonly draft: boolean;
  /** Whether the commit read has the file (false: only a working copy holds it). */
  readonly committed: boolean;
}

/** Where content lives: a Git repository, read at any branch, tag or commit. */
export abstract class ContentRepository {
  /** `undefined` when the ref does not exist or is not safe to pass to Git. */
  abstract at(ref: string): Promise<ContentSnapshot | undefined>;
  abstract refs(): Promise<{ branches: RefInfo[]; tags: RefInfo[] }>;

  /**
   * `at` for each of several refs, in the order given (#764: a product's release tags). An
   * adapter that lists refs to resolve a name lists them once for all of them.
   */
  atEach(refs: readonly string[]): Promise<(ContentSnapshot | undefined)[]> {
    return Promise.all(refs.map((ref) => this.at(ref)));
  }

  /**
   * The release tags (every tag counts as one, as for reading: `released.ts`),
   * newest first by when each was made.
   */
  async releases(): Promise<RefInfo[]> {
    return (await this.refs()).tags;
  }

  /**
   * The repository paths that differ between two commits (full IDs),
   * deleted ones included; undefined when this repository cannot tell
   * (then whatever depends on it works from the files alone). For work kept
   * per commit that can be carried over from another commit's (the module
   * index, #480).
   */
  differingPaths(from: string, to: string): Promise<string[] | undefined> {
    void from;
    void to;
    return Promise.resolve(undefined);
  }
}
