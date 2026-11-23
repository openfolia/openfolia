import { createHash } from 'node:crypto';
import {
  BUILTIN_PAGE_DESIGN_ID,
  choosePageDesign,
  DEFAULT_PAGE_DESIGN,
  manifestAssets,
  manualCoverImage,
  CURRENT_MANIFEST_VERSION,
  pageDesignIdFor,
  resolvePageDesign,
  parseTerm,
  PageDesignId,
  pageDesignAssets,
  type PageDesign,
  type Term,
  TermParseError,
  validateManifest,
  emptyDerivedManual,
  walk,
  type Attachment,
  type Block,
  type Inline,
  type Issue,
  type Manifest,
  type ManifestEntry,
  type Module,
  type ModuleMeta,
  type ProjectConfig,
  type ResolvedEntry,
  textIn,
  type TranslationRecord,
  type VariantValues,
  CONFIG_FILE_NAME,
  isConfigFileName,
  isTemplateFilePath,
  isTemplateTextFile,
  LEGACY_CONFIG_FILE_NAME,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import {
  allows,
  allowsAllIn,
  allowsManual,
  ANYWHERE,
  moduleTarget,
} from '../../access/core/allows.js';
import { readingKey } from '../../access/core/reading-scope.js';
import { foldKeyword } from './module-filter.js';
import { type ContentOverlay, OverlaidSnapshot } from './content-overlay.js';
import { DerivedManuals } from './derived-manuals.js';
import { InvalidContentError } from '../../base/core/errors.js';
import { mapAtMost } from '../../base/core/map-at-most.js';
import { Recent } from '../../base/core/recent.js';
import type {
  ContentSnapshot,
  DeletedManifestFile,
  DeletedModuleFile,
  ManualResolution,
  TemplateFileEntry,
  ModuleFile,
  ModuleFileHistory,
  ModuleFileVersion,
  RenderSource,
} from './content.repository.js';

/**
 * A module file's revision as the actor sees it (`ReadableContent.moduleHistory`):
 * `unreadable` for a broken file, which only a reader of all of its
 * language sees.
 */
export interface SeenRevision {
  readonly revision: string;
  readonly unreadable: boolean;
}

/** A version of a module's file, and the file after it as the actor sees it. */
export interface SeenModuleVersion extends Omit<ModuleFileVersion, 'revision'> {
  /** Undefined when the file is gone or the actor may not see it. */
  readonly seen: SeenRevision | undefined;
}

/** A module file deleted on the line, as the actor sees its last version (`ReadableContent.deletedModules`). */
export interface SeenDeletedModule extends DeletedModuleFile {
  /** The module as it last was, before its newest deletion. */
  readonly module: Module;
}

/** A manual deleted on the line, as the actor sees its last manifest (`ReadableContent.deletedManuals`). */
export interface SeenDeletedManual
  extends DeletedManifestFile, ReadableManual {}

/** A file's versions as the actor sees them (`ReadableContent.moduleHistory`, `manualHistory`). */
export interface SeenHistory {
  readonly versions: readonly SeenModuleVersion[];
  readonly truncated: boolean;
  readonly before: SeenRevision | undefined;
  /** The file did not exist before the oldest commit looked at: the versions are all there are. */
  readonly startsInWindow: boolean;
}

/** A broken manifest's revision as a reader sees it (`manualHistory`, `manualRevision`): all alike. */
const UNREADABLE_MANIFEST = 'unreadable';

/**
 * How many files a listing (`modules`, `manuals`, `terms`) reads at once:
 * enough to keep the Git reader busy, few enough that another request's
 * read never waits behind a whole listing's.
 */
const FILES_AT_ONCE = 32;

/** How many file revisions are read at once for a history. */
const REVISIONS_AT_ONCE = 16;

/** Released content (`main`, release tags) or anything else. */
export type ReadPermission = 'content.read' | 'content.read.draft';

export type ModuleListing =
  (ModuleFile & { module: Module }) | (ModuleFile & { error: string });

/** A problem found in a manifest, or a note that a reference was left out. */
export type ManualIssue =
  | Issue
  | {
      severity: 'warning';
      code: 'outside-scope';
      message: string;
      /** The module whose reference was left out. */
      at: string;
    };

/** A manifest as the actor may read it, with the issues it may learn of. */
export interface ReadableManual {
  /** Its `entries` can be empty (unlike a stored manifest's): never re-parse it as `Manifest`. */
  manifest: Manifest;
  issues: ManualIssue[];
}

export type ManualListing =
  ({ id: string } & ReadableManual) | { id: string; error: string };

/** How `ReadableContent.resolve` resolves a manual. */
export interface ResolveOptions {
  /**
   * The page design to lay it out with in place of its own (the manifest's, else `pdf.design`),
   * by ID, `builtin` for the built-in one: the design screen previews a design with any manual
   * (#392). Designs carry no audience, so this shows nothing the reader could not read.
   */
  readonly design?: string;
  /**
   * The release the PDF is made for (#395): its name (the revision, `2.3`) and date
   * (`YYYY-MM-DD`), which the page design's `release` and `date` placeholders and fields show.
   * None: a preview or a download, which leaves them out.
   */
  readonly release?: ReleaseFacts;
}

/** What a release's PDF prints of its release (#395): its name and date (`YYYY-MM-DD`). */
export interface ReleaseFacts {
  readonly name: string;
  readonly date: string;
}

/** A page design, or a file in `design/` that is no design (with why). */
export type PageDesignListing =
  { id: string; design: PageDesign } | { id: string; error: string };

/** A term, or a file in `terms/` that is no term (with why). */
export type TermListing =
  { id: string; term: Term } | { id: string; error: string };

const OUTSIDE_SCOPE = 'left out: outside what the reader may see';

/** What `ReadableContent.judgeIndexed` decides on. */
export interface IndexJudge {
  /** Whether the actor may see this module file (`meta` absent: a file that cannot be read). */
  module(entry: {
    readonly lang: string;
    readonly meta?: Pick<ModuleMeta, 'type' | 'audience' | 'facets'>;
  }): boolean;
  /** Whether the actor may see this manual (`error`: a manifest that cannot be read). */
  manual(entry: {
    readonly audience?: string | undefined;
    readonly error?: string | undefined;
  }): boolean;
}

/** A manual whose manifest has a file as its cover image (#394). */
export interface ManualCoverUse {
  readonly manualId: string;
  readonly title: string;
}

/** A module that shows an image or attaches a file: one language of it. */
export interface AssetUse {
  readonly moduleId: string;
  readonly lang: string;
  readonly title: string;
  /**
   * What describes the file in this module: the alt text and the title
   * (as plain text) of each of its image blocks showing it, and the name,
   * description and file name of each attachment block attaching it, in
   * block order. For finding files; it is the module's own text.
   */
  readonly descriptions: readonly string[];
  /** Whether an image block of this module shows it. */
  readonly asImage: boolean;
  /**
   * The file names of the attachment blocks of this module attaching it,
   * in block order (none when only images show it): what a download of
   * it is named.
   */
  readonly fileNames: readonly string[];
  /**
   * The module ID, the title and the descriptions, each folded as
   * `foldKeyword` folds (case, diacritics and runs of whitespace aside),
   * one per line: what a search compares against, folded once per commit
   * and reading key.
   */
  readonly searchText: string;
}

/** An attachment block of a module the actor may see (`ReadableContent.attachments`, #139). */
export interface AttachmentUse {
  readonly moduleId: string;
  readonly lang: string;
  /** The module's title. */
  readonly title: string;
  /** The module's facets (`meta.facets`): which products it is for, among others. */
  readonly facets: Readonly<Record<string, readonly string[]>>;
  /** The block, nested ones too; shared: never change it. */
  readonly block: Attachment;
}

/**
 * Per commit and reading key, the attachment blocks as `attachments()` lists them: reading them
 * parses every module the reader may see, too much to do again for every request.
 */
const attachmentListings = new Recent<readonly AttachmentUse[]>(64);

/**
 * Per image reference (`sha256:<hash>`), the readable modules showing it,
 * per commit and reading key.
 */
const referencedAssets = new Map<
  string,
  Promise<ReadonlyMap<string, readonly AssetUse[]>>
>();
const REFERENCED_ASSETS_KEPT = 64;

/**
 * Per commit and reading key, the manuals as `manuals()` lists them: a
 * list of manuals reads every manifest and judges every module it names,
 * too much to do again for every request.
 */
const manualListings = new Recent<readonly ManualListing[]>(64);

/**
 * The content at one commit as one actor may read it: the only way actions
 * reach content (`OpenSnapshotAction` makes it; the raw snapshot is private
 * to it). Every read is filtered by the actor's roles holding `permission`
 * (`content.read` for released refs, `content.read.draft` for others):
 *
 * - a module outside every such role's scope is not there, exactly as if it
 *   did not exist; a file that cannot be read is reported (its path and
 *   error) only to an actor who may read everything in its language
 *   (`allowsAllIn`), and is not there for anyone else;
 * - a manual is there for a role whose `maxAudience` covers the manifest's
 *   audience (none: the most restricted level); a manifest that cannot be
 *   read only for one that covers every level. Its manifest names only the
 *   modules the actor may see in some language (a reference to a module that
 *   exists in none is kept: it hides nothing), its groups left empty go too,
 *   and its validation issues are those of what is left (`outside-scope`
 *   notes for what was left out, for `content.read.draft` holders only);
 *   resolving it also needs the
 *   language in that role's scope, and leaves out the modules the actor may
 *   not see (`outside-scope` issues, kept only for `content.read.draft`
 *   holders; without it a module left out and a missing one both go
 *   unreported, so they look alike); what is resolved is the manifest as
 *   the actor may read it, so an entry left out is never evaluated;
 * - an asset is there when a readable module refers to it.
 *
 * Lists are filtered before they are paged, so totals count only what the
 * actor may see.
 */
export class ReadableContent {
  /** The snapshot, its derived manuals gathered (#451). */
  readonly #raw: DerivedManuals;
  readonly #actor: Actor;
  readonly #resolved = new WeakSet<ManualResolution>();
  /** Per module ID: whether a manifest may name it (see `#named`). */
  readonly #nameable = new Map<string, Promise<boolean>>();
  #files: Promise<Map<string, string[]>> | undefined;
  #overlayAssets: Promise<ReadonlyMap<string, readonly AssetUse[]>> | undefined;
  /** Read through an overlay (`withOverlay`): nothing of it is cached across requests. */
  readonly #overlaid: boolean;
  readonly commit: string;

  /** Equal for two actors who see the same here; for ETags and cache keys. */
  readonly readingKey: string;

  /** Whether this is read through an overlay (`withOverlay`): then nothing of it is to be cached. */
  get overlaid(): boolean {
    return this.#overlaid;
  }

  constructor(
    raw: ContentSnapshot,
    actor: Actor,
    readonly permission: ReadPermission,
    overlayKey?: string,
  ) {
    // A derived manual is gathered only from a source manual the actor may see (#451).
    // A notice gathering reads only modules the actor may see (#670), as its entries name them.
    this.#raw = DerivedManuals.of(
      raw,
      async (source) =>
        this.#seesManual(source.audience, undefined, await raw.config()),
      async (id) => this.#mayName(id, await raw.config()),
    );
    this.#actor = actor;
    this.commit = raw.commit;
    this.#overlaid = overlayKey !== undefined;
    this.readingKey =
      readingKey(actor, permission) +
      (overlayKey === undefined ? '' : `|${overlayKey}`);
  }

  /**
   * This commit as the actor reads it with `content.read.draft` (#410):
   * itself when it is read so already, else through their draft scopes
   * (which can be narrower than their `content.read` ones); undefined
   * when they hold `content.read.draft` nowhere, or when this content is
   * read through an overlay (nothing of it is to be cached apart from it).
   * For deciding whether what a released read derives from draft commits
   * (a history, a deleted manual's last manifest) lies within their draft
   * scope too.
   */
  asDrafts(): ReadableContent | undefined {
    if (this.permission === 'content.read.draft') return this;
    if (this.#overlaid) return undefined;
    return allows(this.#actor, 'content.read.draft', ANYWHERE)
      ? new ReadableContent(this.#raw, this.#actor, 'content.read.draft')
      : undefined;
  }

  /**
   * This content with `overlay`'s drafts in place of their files (a change
   * set's working copies, for its author's live preview), read by the same
   * actor with the same permission, so every draft is filtered as a file
   * would be. Images: only those this content shows (a module the actor
   * may see refers to them, a page design at this commit names them:
   * every reader's, #392, or a manual the actor may see has them as its
   * cover image, #394) and those the overlay shows. Its reading key
   * carries the overlay's, so no cache or ETag is shared with this one.
   */
  withOverlay(overlay: ContentOverlay): ReadableContent {
    return new ReadableContent(
      new OverlaidSnapshot(
        this.#raw,
        overlay,
        async (hash) =>
          (await this.refersToAsset(hash)) ||
          (await this.pageDesignAssets()).has(`sha256:${hash}`) ||
          (await this.manualCoverAssets()).has(`sha256:${hash}`),
      ),
      this.#actor,
      this.permission,
      overlay.key,
    );
  }

  /**
   * The text attributes a manual is resolved with (`resolve`): a derived manual's source's with
   * its own over them (#451), any other manual's own. For an output made from the manifest
   * itself (the DITA export's keys). Values only, never modules: nothing to filter.
   */
  textAttributesOf(manifest: Manifest): Promise<Manifest['attributes']> {
    return this.#raw.textAttributes(manifest);
  }

  /** The project configuration: not scoped, every reader needs it. */
  config(): Promise<ProjectConfig> {
    return this.#raw.config();
  }

  /** The modules the actor may see (optionally in one language), and the broken files it may learn of. */
  async modules(lang?: string): Promise<ModuleListing[]> {
    const [files, config] = await Promise.all([
      this.#raw.modules(lang),
      this.#raw.config(),
    ]);
    const listed = await mapAtMost(
      files,
      FILES_AT_ONCE,
      async (file): Promise<ModuleListing | undefined> => {
        try {
          const module = await this.#raw.module(file.id, file.lang);
          if (module) {
            return this.#sees(module, config) ? { ...file, module } : undefined;
          }
          return this.#seesAllIn(file.lang)
            ? { ...file, error: 'The module file is gone.' }
            : undefined;
        } catch (error) {
          if (!(error instanceof InvalidContentError)) throw error;
          return this.#seesAllIn(file.lang)
            ? { ...file, error: error.message }
            : undefined;
        }
      },
    );
    return listed.filter((entry) => entry !== undefined);
  }

  /**
   * A module, or `undefined` when it does not exist or the actor may not see
   * it. A broken file throws `InvalidContentError` only for an actor who may
   * read everything in its language.
   */
  async module(id: string, lang: string): Promise<Module | undefined> {
    // The configuration first: its failing must not depend on the module existing.
    const config = await this.#raw.config();
    let module: Module | undefined;
    try {
      module = await this.#raw.module(id, lang);
    } catch (error) {
      if (error instanceof InvalidContentError && !this.#seesAllIn(lang)) {
        return undefined;
      }
      throw error;
    }
    return module && this.#sees(module, config) ? module : undefined;
  }

  /**
   * The revision of a module's file (`ContentSnapshot.moduleRevision`: equal
   * revisions, equal files), or `undefined` when it does not exist or the
   * actor may not see it (a broken file: only for an actor who may read
   * everything in its language, as `module` reports it).
   */
  async moduleRevision(id: string, lang: string): Promise<string | undefined> {
    // A broken configuration fails here as every read does, not as the module.
    await this.#raw.config();
    const revision = await this.#raw.moduleRevision(id, lang);
    if (revision === undefined) return undefined;
    try {
      return (await this.module(id, lang)) ? revision : undefined;
    } catch (error) {
      if (error instanceof InvalidContentError) return revision;
      throw error;
    }
  }

  /**
   * The translation record of a module's file in a target language (what
   * each of its blocks was translated from), or `undefined` when there is
   * none or the actor may not see that file (`module`; a broken module
   * file has none for anyone). A record that cannot be parsed throws
   * `InvalidContentError`, to a reader who sees the module.
   */
  async translationRecord(
    id: string,
    lang: string,
  ): Promise<TranslationRecord | undefined> {
    let module: Module | undefined;
    try {
      module = await this.module(id, lang);
    } catch (error) {
      if (error instanceof InvalidContentError) return undefined;
      throw error;
    }
    return module ? this.#raw.translationRecord(id, lang) : undefined;
  }

  /**
   * Whether the actor, reading here, would see a subject read at another
   * commit: `module` (with this commit's configuration), a broken module
   * file in `lang`, a manual of `audience` or a broken manifest. Reads no
   * content; for comparing two commits through what the actor sees on
   * both, when they were opened with different permissions (a released
   * base, a draft head).
   */
  async wouldSee(
    subject:
      | { readonly module: Module }
      | { readonly brokenModuleIn: string }
      | { readonly manualAudience: string | undefined }
      | { readonly brokenManual: true },
  ): Promise<boolean> {
    const config = await this.#raw.config();
    if ('module' in subject) return this.#sees(subject.module, config);
    if ('brokenModuleIn' in subject) {
      return this.#seesAllIn(subject.brokenModuleIn);
    }
    if ('manualAudience' in subject) {
      return this.#seesManual(subject.manualAudience, undefined, config);
    }
    return this.#seesEveryManual(config);
  }

  /**
   * The versions of a module's file on this commit's first-parent line
   * (`ContentSnapshot.moduleHistory`: the commits among the newest `max`
   * that changed it, newest first), each with the file after it as the
   * actor sees it here: by this commit's configuration and this
   * permission's scopes, a revision outside them is not there, exactly
   * like a deleted file, and a broken one is there only for a reader of
   * all of its language. `before` likewise, when the walk was cut. Reads
   * the module at each version (by revision, so each is parsed once).
   * `undefined` when the module's last file (here, or the last before it
   * was deleted) is one the actor may not see: a module outside their
   * scope has no history for them, exactly like one that does not exist.
   * `startsInWindow`: the file did not exist before the oldest commit
   * looked at, so the versions listed are all there are.
   */
  async moduleHistory(
    id: string,
    lang: string,
    max: number,
  ): Promise<SeenHistory | undefined> {
    const config = await this.#raw.config();
    return this.#seenHistory(
      await this.#raw.moduleHistory(id, lang, max),
      async (revision) => {
        try {
          const module = await this.#raw.moduleAtRevision(id, lang, revision);
          return module && this.#sees(module, config)
            ? { revision, unreadable: false }
            : undefined;
        } catch (error) {
          if (!(error instanceof InvalidContentError)) throw error;
          return this.#seesAllIn(lang)
            ? { revision, unreadable: true }
            : undefined;
        }
      },
    );
  }

  /**
   * The versions of a manual's manifest on this commit's first-parent line
   * (`ContentSnapshot.manifestHistory`), as `moduleHistory` gives a
   * module's: each manifest judged as `manual` judges it here, by its
   * audience (a broken one only for a reader of every audience), so a
   * revision outside the reader's scope is not there. A revision is the
   * manifest as the reader sees it (`#view`: naming only the modules they
   * may see), so a commit that changed only entries hidden from them is no
   * version, and consecutive commits they see alike are one. `undefined` when its
   * last manifest (here, or the last before it was deleted) is one they may
   * not see.
   */
  async manualHistory(
    id: string,
    max: number,
  ): Promise<SeenHistory | undefined> {
    const config = await this.#raw.config();
    return this.#seenHistory(
      await this.#raw.manifestHistory(id, max),
      async (revision) => {
        try {
          const manifest = await this.#raw.manifestAtRevision(id, revision);
          return manifest &&
            this.#seesManual(manifest.audience, undefined, config)
            ? {
                revision: await this.#view(manifest, config),
                unreadable: false,
              }
            : undefined;
        } catch (error) {
          if (!(error instanceof InvalidContentError)) throw error;
          // One key for every broken manifest: what differs between two of them
          // may be entries hidden from the reader.
          return this.#seesEveryManual(config)
            ? { revision: UNREADABLE_MANIFEST, unreadable: true }
            : undefined;
        }
      },
    );
  }

  /** A file's history with each revision as `seen` judges it (`moduleHistory`, `manualHistory`). */
  async #seenHistory(
    history: ModuleFileHistory,
    seen: (revision: string) => Promise<SeenRevision | undefined>,
  ): Promise<SeenHistory | undefined> {
    const judge = (revision: string | undefined) =>
      revision === undefined ? Promise.resolve(undefined) : seen(revision);
    // The last file: the newest version's that has one, else (unchanged
    // since the oldest commit looked at) the one before.
    const last =
      history.versions.find((v) => v.revision !== undefined)?.revision ??
      history.before;
    if (last !== undefined && (await judge(last)) === undefined) {
      return undefined;
    }
    const versions: SeenModuleVersion[] = [];
    for (let i = 0; i < history.versions.length; i += REVISIONS_AT_ONCE) {
      const batch = history.versions.slice(i, i + REVISIONS_AT_ONCE);
      versions.push(
        ...(await Promise.all(
          batch.map(async ({ revision, ...version }) => ({
            ...version,
            seen: await judge(revision),
          })),
        )),
      );
    }
    return {
      versions,
      truncated: history.truncated,
      before: await judge(history.before),
      startsInWindow: !history.truncated || history.before === undefined,
    };
  }

  /**
   * The revision of a manual's manifest as the actor sees it (`#view`, as
   * `manualHistory` gives it; a broken one: `UNREADABLE_MANIFEST`), or `undefined`
   * when there is none or the actor may not see the manual
   * (a broken one: only for a reader of every audience, as `manual` reports
   * it).
   */
  async manualRevision(id: string): Promise<string | undefined> {
    const config = await this.#raw.config();
    const revision = await this.#raw.manifestRevision(id);
    if (revision === undefined) return undefined;
    try {
      const manifest = await this.#manifest(id, config);
      return manifest && this.#view(manifest, config);
    } catch (error) {
      if (error instanceof InvalidContentError) return UNREADABLE_MANIFEST;
      throw error;
    }
  }

  /**
   * A manual's revision as the actor sees it (`manualHistory`, `manualRevision`): a hash of its
   * manifest naming only what they may see here (`#readable`), never its file's blob, so a
   * change to entries hidden from them is no version and tells them nothing. A derived manual's
   * (#451) leaves its gathered entries out: they are gathered from the content of the commit
   * read, so an earlier revision read here and the same revision read at its own commit (a
   * release's) hash alike, and a change to its source alone is no version of it.
   */
  async #view(manifest: Manifest, config: ProjectConfig): Promise<string> {
    const { manifest: named } = await this.#named(manifest, config, (m) =>
      this.#mayNameFromThen(m, config),
    );
    const seen = named.kind === 'derived' ? { ...named, entries: [] } : named;
    return `view:${createHash('sha256').update(JSON.stringify(seen)).digest('hex')}`;
  }

  /**
   * The manuals deleted on this commit's first-parent line
   * (`ContentSnapshot.deletedManifests`: among the newest `max` commits) as
   * the actor sees them, as `deletedModules` lists modules: one is listed
   * when there is no manifest of it here and its last manifest (the one
   * before its newest deletion) is one they may see, judged by its
   * audience as `manual` judges it here; one that cannot be read is left
   * out (it has no title to list). Its manifest names only what the actor
   * may see, as `manual`'s does. So every manual listed has a history for
   * them, and one outside their scope is not listed at all. Newest deletion
   * first.
   */
  async deletedManuals(max: number): Promise<{
    readonly files: readonly SeenDeletedManual[];
    readonly truncated: boolean;
  }> {
    const config = await this.#raw.config();
    const [deleted, here] = await Promise.all([
      this.#raw.deletedManifests(max),
      this.#raw.manifests(),
    ]);
    const present = new Set(here);
    const files: SeenDeletedManual[] = [];
    const candidates = deleted.files.filter((f) => !present.has(f.id));
    for (let i = 0; i < candidates.length; i += REVISIONS_AT_ONCE) {
      const batch = candidates.slice(i, i + REVISIONS_AT_ONCE);
      const read = await Promise.all(
        batch.map(async (file): Promise<SeenDeletedManual | undefined> => {
          try {
            const manifest = await this.#raw.manifestAtRevision(
              file.id,
              file.revision,
            );
            return manifest &&
              this.#seesManual(manifest.audience, undefined, config)
              ? {
                  ...file,
                  ...(await this.#readable(manifest, config, (m) =>
                    this.#mayNameFromThen(m, config),
                  )),
                }
              : undefined;
          } catch (error) {
            if (error instanceof InvalidContentError) return undefined;
            throw error;
          }
        }),
      );
      files.push(...read.filter((f) => f !== undefined));
    }
    return { files, truncated: deleted.truncated };
  }

  /**
   * The modules deleted on this commit's first-parent line
   * (`ContentSnapshot.deletedModules`: among the newest `max` commits) as
   * the actor sees them: a module ID is listed when the actor sees no file
   * of it here, with each of its deleted files whose last version (the
   * file before its newest deletion) they may see, judged by this commit's
   * configuration and this permission's scopes, as `moduleHistory` judges
   * the last file. A last version that cannot be read is left out (it has
   * no title to list). So every file listed has a history for them, and a
   * module outside their scope is not listed at all. Newest deletion
   * first.
   */
  async deletedModules(max: number): Promise<{
    readonly files: readonly SeenDeletedModule[];
    readonly truncated: boolean;
  }> {
    const config = await this.#raw.config();
    const [deleted, here] = await Promise.all([
      this.#raw.deletedModules(max),
      this.modules(),
    ]);
    const present = new Set(here.map((m) => m.id));
    const files: SeenDeletedModule[] = [];
    const candidates = deleted.files.filter((f) => !present.has(f.id));
    for (let i = 0; i < candidates.length; i += REVISIONS_AT_ONCE) {
      const batch = candidates.slice(i, i + REVISIONS_AT_ONCE);
      const read = await Promise.all(
        batch.map(async (file): Promise<SeenDeletedModule | undefined> => {
          try {
            const module = await this.#raw.moduleAtRevision(
              file.id,
              file.lang,
              file.revision,
            );
            return module && this.#sees(module, config)
              ? { ...file, module }
              : undefined;
          } catch (error) {
            if (error instanceof InvalidContentError) return undefined;
            throw error;
          }
        }),
      );
      files.push(...read.filter((f) => f !== undefined));
    }
    return { files, truncated: deleted.truncated };
  }

  /**
   * `manifest`, read through `from` (the same actor at another commit),
   * naming only what a manifest may name to the actor here too (`#named`):
   * with `wouldSee`, for comparing two commits through what the actor sees
   * on both. A module with no file here is judged by its files in `from`,
   * under this permission, so one deleted or added between the two commits
   * is named only where it would be on both.
   */
  async namedHere(
    manifest: Manifest,
    from: ReadableContent,
  ): Promise<Manifest> {
    const config = await this.#raw.config();
    const files = await this.#moduleFiles();
    const named = await this.#named(manifest, config, (id) =>
      files.has(id)
        ? this.#mayName(id, config)
        : this.#nameableIn(from, id, config),
    );
    return named.manifest;
  }

  /**
   * Whether a module that something here refers to (a manifest, a module
   * reference, a cross-reference) is missing: it has a file in no
   * language. Only an actor who is told what was left out
   * (`content.read.draft`) learns it, as a resolution reports
   * `missing-module` only to them, or one from whom nothing here is hidden
   * (a role reading here whose scope restricts nothing); for anyone else
   * it is false, so a missing module and one they may not see look alike.
   * A module with a file the actor may not see is not missing.
   */
  async missingModule(id: string): Promise<boolean> {
    if (!this.#notes() && !this.#seesEverything()) return false;
    return !(await this.#moduleFiles()).has(id);
  }

  /**
   * Whether a manual something here names (a deprecation's replacement,
   * #266) is missing: there is no manifest of that ID. Told only to the
   * same actors as `missingModule`, so a missing manual and one they may
   * not see look alike to anyone else.
   */
  async missingManual(id: string): Promise<boolean> {
    if (!this.#notes() && !this.#seesEverything()) return false;
    return !(await this.#raw.manifests()).includes(id);
  }

  /**
   * Who may see what in an index of this commit (the module index, #45,
   * which holds the files unfiltered): a module and a manual exactly as
   * `modules()` and `manuals()` list them. A module with `meta` is judged
   * by that metadata as `module()` judges the parsed file; one without
   * (a file that cannot be read) only for an actor who may read everything
   * in its language; a manual by its audience, one that cannot be read
   * only for an actor who sees every level. Only for this commit as
   * committed: content read through an overlay is not in any index.
   */
  async judgeIndexed(commit: string): Promise<IndexJudge> {
    if (this.#overlaid || commit !== this.commit) {
      throw new Error('An index describes a commit, not this content.');
    }
    const config = await this.#raw.config();
    return {
      module: ({ lang, meta }) =>
        meta
          ? allows(
              this.#actor,
              this.permission,
              moduleTarget({ ...meta, lang }, config),
            )
          : this.#seesAllIn(lang),
      manual: ({ audience, error }) =>
        error === undefined
          ? this.#seesManual(audience, undefined, config)
          : this.#seesEveryManual(config),
    };
  }

  /**
   * Whether nothing here is hidden from the actor (a role reading here
   * restricts nothing): what they read is what a reader of everything
   * reads, filtered by nothing.
   */
  seesEverything(): boolean {
    return this.#seesEverything();
  }

  /** Whether a role reading here restricts nothing: nothing here is hidden from the actor. */
  #seesEverything(): boolean {
    return this.#actor.roles.some(
      ({ permissions, scope }) =>
        permissions.includes(this.permission) &&
        Object.values(scope).every((value) => value === undefined),
    );
  }

  /**
   * Whether the actor may read a manual of `audience` (its manifest's) in
   * `lang` here: `manual` and `manuals` judge the audience only.
   */
  async seesManualIn(
    audience: string | undefined,
    lang: string,
  ): Promise<boolean> {
    return this.#seesManual(audience, lang, await this.#raw.config());
  }

  /**
   * Whether one role reading here covers all of a manual of `audience` in
   * `lang`: its audience, its language and the source language (a module
   * not translated falls back to it), with no module type and no facet
   * left out. For a file made as the manual's audience reads it (a release
   * output, #249), which may hold any module the manual names: a reader
   * restricted by module type, facet or language would see in it what
   * their scope leaves out, so only a reader of all of it may have it.
   */
  async seesWholeManualIn(
    audience: string | undefined,
    lang: string,
  ): Promise<boolean> {
    const config = await this.#raw.config();
    return this.#actor.roles.some(
      (role) =>
        role.scope.moduleTypes === undefined &&
        role.scope.facets === undefined &&
        (role.scope.languages === undefined ||
          role.scope.languages.includes(config.languages.source)) &&
        allowsManual({ ...this.#actor, roles: [role] }, this.permission, {
          audiences: config.audiences.map((a) => a.id),
          audience,
          lang,
        }),
    );
  }

  /**
   * The manuals the actor may see, and the broken manifests it may learn
   * of. Worked out once per commit and reading key (`manualListings`);
   * the list is the caller's, the listings in it are shared: never change
   * them.
   */
  async manuals(): Promise<ManualListing[]> {
    // Drafts change between two reads of the same commit: never kept.
    if (this.#overlaid) return this.#listManuals();
    return [
      ...(await manualListings.get(`${this.commit}|${this.readingKey}`, () =>
        this.#listManuals(),
      )),
    ];
  }

  async #listManuals(): Promise<ManualListing[]> {
    const [ids, config] = await Promise.all([
      this.#raw.manifests(),
      this.#raw.config(),
    ]);
    const listed = await mapAtMost(
      ids,
      FILES_AT_ONCE,
      async (id): Promise<ManualListing | undefined> => {
        try {
          const manifest = await this.#raw.manifest(id);
          if (manifest) {
            return this.#seesManual(manifest.audience, undefined, config)
              ? { id, ...(await this.#readable(manifest, config)) }
              : undefined;
          }
          return this.#seesEveryManual(config)
            ? { id, error: 'The manifest file is gone.' }
            : undefined;
        } catch (error) {
          if (!(error instanceof InvalidContentError)) throw error;
          return this.#seesEveryManual(config)
            ? { id, error: error.message }
            : undefined;
        }
      },
    );
    return listed.filter((entry) => entry !== undefined);
  }

  /**
   * The modules each derived manual gathering safety notices (#670) gathers for the actor, by
   * manual ID: what its entries name as `manual` gives it (only from modules the actor may see),
   * each once, in order. For indexes built for everyone (`ReadableModuleIndex`), whose lists of
   * such a manual would tell which modules hold notices the actor may not see.
   */
  async noticeManualModules(): Promise<Map<string, string[]>> {
    const found = new Map<string, string[]>();
    await mapAtMost(await this.#raw.manifests(), FILES_AT_ONCE, async (id) => {
      if (!(await this.#raw.gathersNotices(id))) return;
      // Fails closed: a manual the actor may not read, or no longer can, names nothing.
      let modules: string[] = [];
      try {
        const manual = await this.manual(id);
        if (manual) {
          modules = [...new Set(manifestModules(manual.manifest.entries))];
        }
      } catch (error) {
        if (!(error instanceof InvalidContentError)) throw error;
      }
      found.set(id, modules);
    });
    return found;
  }

  /**
   * A manual's manifest, naming only what the actor may see, with its
   * issues; `undefined` when it does not exist or the actor may not see the
   * manual. A broken file throws `InvalidContentError` only for an actor who
   * may see a manual of any audience.
   */
  async manual(id: string): Promise<ReadableManual | undefined> {
    const config = await this.#raw.config();
    const manifest = await this.#manifest(id, config);
    return manifest && this.#readable(manifest, config);
  }

  /**
   * The manual as `manual` gives it, when its manifest file here is exactly
   * `revision` (a blob, as `deletedManuals` names a last manifest); else,
   * and when it cannot be read, `undefined`. For finding a deleted
   * manual's last manifest in released content (#410).
   */
  async manualWithFile(
    id: string,
    revision: string,
  ): Promise<ReadableManual | undefined> {
    if ((await this.#raw.manifestRevision(id)) !== revision) return undefined;
    try {
      return await this.manual(id);
    } catch (error) {
      if (error instanceof InvalidContentError) return undefined;
      throw error;
    }
  }

  /**
   * The module file as `module` gives it, when its file here is exactly
   * `revision` (a blob, as `deletedModules` names a last version); else,
   * and when it cannot be read, `undefined`. For finding a deleted
   * module's last version in released content (#418).
   */
  async moduleWithFile(
    id: string,
    lang: string,
    revision: string,
  ): Promise<Module | undefined> {
    if ((await this.#raw.moduleRevision(id, lang)) !== revision) {
      return undefined;
    }
    try {
      return await this.module(id, lang);
    } catch (error) {
      if (error instanceof InvalidContentError) return undefined;
      throw error;
    }
  }

  /** The unfiltered manifest of a manual the actor may see. */
  async #manifest(
    id: string,
    config: ProjectConfig,
  ): Promise<Manifest | undefined> {
    let manifest: Manifest | undefined;
    try {
      manifest = await this.#raw.manifest(id);
    } catch (error) {
      if (
        error instanceof InvalidContentError &&
        !this.#seesEveryManual(config)
      ) {
        return undefined;
      }
      throw error;
    }
    return manifest && this.#seesManual(manifest.audience, undefined, config)
      ? manifest
      : undefined;
  }

  /**
   * A manual resolved with only the modules the actor may see, or
   * `undefined` when there is no such manual or the actor may not see it in
   * `lang`.
   */
  async resolve(
    id: string,
    variant: VariantValues,
    lang: string,
    options: ResolveOptions = {},
  ): Promise<ManualResolution | undefined> {
    const config = await this.#raw.config();
    const manifest = await this.#manifest(id, config);
    if (!manifest || !this.#seesManual(manifest.audience, lang, config)) {
      return undefined;
    }
    // Only what the reader may see is resolved: an entry left out is not
    // evaluated, so its condition cannot raise an issue that hints at it.
    const named = await this.#named(manifest, config);
    // A derived manual takes its source's text attributes under its own (#451).
    const resolving: Manifest = {
      ...named.manifest,
      attributes: await this.#raw.textAttributes(manifest),
    };
    const resolution = await this.#raw.resolve(
      resolving,
      variant,
      lang,
      (module) => this.#sees(module, config),
    );
    if (!resolution) return undefined;
    const result = {
      ...resolution,
      manifest: resolving,
      issues: this.#readableIssues(resolution, named.left, lang, config),
      ...(await this.#pageDesign(
        options.design === undefined
          ? resolving
          : { ...resolving, design: options.design },
        variant,
        lang,
        config,
        options.release,
      )),
    };
    this.#resolved.add(result);
    return result;
  }

  /**
   * The manual's page design (#391), resolved for its variant and language: none for the
   * built-in design, whose PDF is the default one, unless the manual gives the variant a cover
   * image (#394). A design that is not there or cannot be
   * read is reported (`unknown-page-design`) and the default PDF made, so a preview still
   * renders. Designs carry no audience: every reader of the manual reads its design.
   */
  async #pageDesign(
    manifest: Manifest,
    variant: VariantValues,
    lang: string,
    config: ProjectConfig,
    release?: ReleaseFacts,
  ): Promise<Pick<ManualResolution, 'design' | 'designIssues'>> {
    const facts = release && { release: release.name, date: release.date };
    const id = pageDesignIdFor(manifest, config);
    if (id === BUILTIN_PAGE_DESIGN_ID) {
      // The built-in design's PDF is the default one, which has no cover image: a manual giving
      // this variant one of its own (#394) is laid out with the built-in design (classic).
      if (!manualCoverImage(manifest, variant)) return {};
      const builtin = resolvePageDesign({
        design: DEFAULT_PAGE_DESIGN,
        manifest,
        variant,
        lang,
        config,
        ...facts,
      });
      return { design: builtin.design, designIssues: builtin.issues };
    }
    let loaded: PageDesign | undefined;
    try {
      loaded = await this.#raw.pageDesign(id);
    } catch (error) {
      if (!(error instanceof InvalidContentError)) throw error;
    }
    const chosen = choosePageDesign({
      manifest,
      config,
      loadDesign: () => loaded,
    });
    if (!loaded) {
      // The built-in design is used, as for a manual on it: with its cover image (#394).
      if (!manualCoverImage(manifest, variant)) {
        return { designIssues: chosen.issues };
      }
      const builtin = resolvePageDesign({
        design: DEFAULT_PAGE_DESIGN,
        manifest,
        variant,
        lang,
        config,
        ...facts,
      });
      return {
        design: builtin.design,
        designIssues: [...chosen.issues, ...builtin.issues],
      };
    }
    const { design, issues } = resolvePageDesign({
      design: chosen.design,
      manifest,
      variant,
      lang,
      config,
      ...facts,
    });
    return { design, designIssues: issues };
  }

  /**
   * One module on its own, resolved for a variant and language (a manifest
   * listing only it, so the conditions inside it apply as in a manual), or
   * `undefined` when the actor may not see it in `lang` or there is none:
   * both answer alike. Needs no manual, so no audience check beyond the
   * module's own scope.
   */
  async resolveModule(
    id: string,
    variant: VariantValues,
    lang: string,
  ): Promise<ManualResolution | undefined> {
    const module = await this.module(id, lang);
    if (!module) return undefined;
    const config = await this.#raw.config();
    const manifest: Manifest = {
      schemaVersion: CURRENT_MANIFEST_VERSION,
      id,
      title: module.meta.title,
      variants: [variant],
      attributes: {},
      entries: [{ module: id }],
    };
    const resolution = await this.#raw.resolve(
      manifest,
      variant,
      lang,
      (candidate) => this.#sees(candidate, config),
    );
    if (!resolution) return undefined;
    const result = {
      ...resolution,
      issues: this.#readableIssues(resolution, [], lang, config),
    };
    this.#resolved.add(result);
    return result;
  }

  /**
   * For checking a change in core, never for a response: the committed
   * module's metadata whether or not the actor may read it, so a check
   * can tell a hidden file from a missing one and refuse rather than fail
   * open. `undefined` when there is none, `'unreadable'` for a broken file.
   */
  async moduleMetaForCheck(
    id: string,
    lang: string,
  ): Promise<ModuleMeta | 'unreadable' | undefined> {
    try {
      return (await this.#raw.module(id, lang))?.meta;
    } catch (error) {
      if (error instanceof InvalidContentError) return 'unreadable';
      throw error;
    }
  }

  /**
   * For checking a change in core, never for a response (#554): every manifest at this commit
   * with the page design it names (`design`, undefined for none) and its audience, whether or
   * not the actor may read it. A broken file is left out: it names no design one can tell.
   */
  async manifestDesignsForCheck(): Promise<
    { id: string; design: string | undefined; audience: string | undefined }[]
  > {
    const found: {
      id: string;
      design: string | undefined;
      audience: string | undefined;
    }[] = [];
    for (const id of await this.#raw.manifests()) {
      let manifest: Manifest | undefined;
      try {
        manifest = await this.#raw.manifest(id);
      } catch (error) {
        if (error instanceof InvalidContentError) continue;
        throw error;
      }
      if (manifest) {
        found.push({
          id,
          design: manifest.design,
          audience: manifest.audience,
        });
      }
    }
    return found;
  }

  /**
   * For checking a change in core, never for a response: the committed
   * manifest's audience whether or not the actor may read it, and whether
   * it names modules the actor may not see (worked out from the manifest
   * itself, not from the `outside-scope` notes, which only some readers
   * get). `undefined` when there is none, `'unreadable'` for a broken file.
   */
  async manifestForCheck(
    id: string,
  ): Promise<
    | { audience: string | undefined; hidesEntries: boolean }
    | 'unreadable'
    | undefined
  > {
    let manifest: Manifest | undefined;
    try {
      manifest = await this.#raw.manifest(id);
    } catch (error) {
      if (error instanceof InvalidContentError) return 'unreadable';
      throw error;
    }
    if (!manifest) return undefined;
    const { left } = await this.#named(manifest, await this.#raw.config());
    return { audience: manifest.audience, hidesEntries: left.length > 0 };
  }

  /**
   * For checking a change in core, never for a response: the bytes of a
   * module's (`modules/<lang>/<id>.adoc`) or manifest's (`manuals/<id>.yaml`)
   * file, a module's translation record
   * (`modules/<lang>/<id>.translation.yaml`, which moves with it when it is
   * renamed), the configuration's (`openfolia.yaml`: the file in effect, so `ccms.yaml`'s
   * bytes where only that is there, #372; `ccms.yaml` names that file alone) or a term's
   * (`terms/<id>.yaml`) or a page design template's text file (`templates/<id>/<path>`, #396),
   * whether or not the actor may read it, so a check
   * can tell whether it changed between two commits or matches what is
   * about to be written. `undefined` when there is none; any other path is
   * refused.
   */
  async sourceForCheck(path: string): Promise<Uint8Array | undefined> {
    if (
      !/^modules\/[A-Za-z0-9-]+\/[a-z0-9-]+\.(?:adoc|translation\.yaml)$/.test(
        path,
      ) &&
      !/^manuals\/[a-z0-9-]+\.yaml$/.test(path) &&
      !/^terms\/[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/.test(path) &&
      !/^design\/[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/.test(path) &&
      !isTemplateFileSource(path) &&
      !isConfigFileName(path)
    ) {
      throw new Error(
        `Not a module's, manifest's, term's, page design's, template file's or the configuration's path: ${path}`,
      );
    }
    if (path === CONFIG_FILE_NAME) {
      return (
        (await this.#raw.file(CONFIG_FILE_NAME)) ??
        this.#raw.file(LEGACY_CONFIG_FILE_NAME)
      );
    }
    return this.#raw.file(path);
  }

  /**
   * The configuration's file in effect at this commit: `openfolia.yaml`, else `ccms.yaml` (its
   * earlier name, read for one release, #372); `undefined` when there is neither.
   */
  async configFileInEffect(): Promise<string | undefined> {
    if ((await this.#raw.file(CONFIG_FILE_NAME)) !== undefined) {
      return CONFIG_FILE_NAME;
    }
    return (await this.#raw.file(LEGACY_CONFIG_FILE_NAME)) !== undefined
      ? LEGACY_CONFIG_FILE_NAME
      : undefined;
  }

  /**
   * A term's file (`terms/<id>.yaml`) as text, `undefined` when there is
   * none (or the ID is no term's). Terms carry no audience, language scope
   * aside, so every reader of this commit may read them (#135); the caller
   * parses it.
   */
  async termSource(id: string): Promise<string | undefined> {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 100) {
      return undefined;
    }
    const bytes = await this.#raw.file(`terms/${id}.yaml`);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  /**
   * A page design's file (`design/<id>.yaml`, #390) as text, `undefined`
   * when there is none (or the ID is no design's). Designs carry no
   * audience, so every reader of this commit may read them; the caller
   * parses it.
   */
  async pageDesignSource(id: string): Promise<string | undefined> {
    if (!PageDesignId.safeParse(id).success) return undefined;
    const bytes = await this.#raw.file(`design/${id}.yaml`);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }

  /**
   * Every page design at this commit, by ID, and the files that are no
   * design (with why). Designs carry no audience: every reader of the
   * commit reads them all (#390).
   */
  async pageDesigns(): Promise<PageDesignListing[]> {
    const ids = await this.#raw.pageDesigns();
    const listed = await Promise.all(
      ids.map(async (id): Promise<PageDesignListing | undefined> => {
        try {
          const design = await this.#raw.pageDesign(id);
          return design && { id, design };
        } catch (error) {
          if (!(error instanceof InvalidContentError)) throw error;
          return { id, error: error.message };
        }
      }),
    );
    return listed.filter((entry) => entry !== undefined);
  }

  /**
   * The files the page designs at this commit name (`pageDesignAssets`:
   * logo, fonts, cover images, a region's images and attachments), as
   * `sha256:<hash>`. Designs carry no audience: every reader of the commit
   * may name them (a file that is no design names nothing).
   */
  async pageDesignAssets(): Promise<ReadonlySet<string>> {
    const found = new Set<string>();
    for (const entry of await this.pageDesigns()) {
      if (!('design' in entry)) continue;
      for (const { asset } of pageDesignAssets(entry.design)) found.add(asset);
    }
    return found;
  }

  /**
   * The files the manuals the actor may see have as their cover image (#394,
   * `manifestAssets`), as `sha256:<hash>`, each with those manuals in the
   * order they are listed (a manual once per file). A reader of the manual
   * may read its cover image, as the PDF shows it.
   */
  async manualCoverAssets(): Promise<
    ReadonlyMap<string, readonly ManualCoverUse[]>
  > {
    const found = new Map<string, ManualCoverUse[]>();
    const { source } = (await this.config()).languages;
    for (const entry of await this.manuals()) {
      if (!('manifest' in entry)) continue;
      for (const { asset } of manifestAssets(entry.manifest)) {
        const uses = found.get(asset) ?? [];
        if (uses.some((use) => use.manualId === entry.id)) continue;
        uses.push({
          manualId: entry.id,
          title: textIn(entry.manifest.title, source, source),
        });
        found.set(asset, uses);
      }
    }
    return found;
  }

  /**
   * A file of the old layout (`assets/<hash>`) that a page design at this commit names
   * (`pageDesignAssets`, #555): every reader of the commit may read it, as the designs.
   */
  async designAsset(hash: string): Promise<Uint8Array | undefined> {
    return (await this.pageDesignAssets()).has(`sha256:${hash}`)
      ? this.#raw.asset(hash)
      : undefined;
  }

  /**
   * A page design, `undefined` when there is none (or the ID is no design
   * ID); a file that is no design throws `InvalidContentError`. Every
   * reader of the commit reads it.
   */
  pageDesign(id: string): Promise<PageDesign | undefined> {
    return this.#raw.pageDesign(id);
  }

  /**
   * The page design templates there are (#396): their IDs, sorted. Templates carry no audience,
   * as designs: every reader of the commit learns of them.
   */
  designTemplateIds(): Promise<readonly string[]> {
    return this.#raw.designTemplateIds();
  }

  /**
   * A page design template's files (#396, `ContentSnapshot.designTemplate`): for checking a
   * design's template (the checks, the design screen), never served to a reader.
   */
  designTemplate(id: string): Promise<Record<string, Uint8Array> | undefined> {
    return this.#raw.designTemplate(id);
  }

  /**
   * A page design template's folder as the template screen lists it (#396,
   * `ContentSnapshot.designTemplateListing`): its files by path, size and whether a working copy
   * stands in for one. Templates carry no audience: every reader of the commit reads them.
   */
  designTemplateListing(id: string): Promise<readonly TemplateFileEntry[]> {
    return this.#raw.designTemplateListing(id);
  }

  /** One file of a page design template's folder by its path in it (#396); undefined: none. */
  designTemplateFile(
    id: string,
    path: string,
  ): Promise<Uint8Array | undefined> {
    return this.#raw.designTemplateFile(id, path);
  }

  /**
   * What a template's files are beyond the commit (#396): empty when read from the commit alone,
   * else a hash of the working copies standing in for them. A rendering key carries it, so a PDF
   * laid out with one draft of a template is never served for another.
   */
  designTemplateRevision(id: string): Promise<string> {
    return this.#raw.designTemplateRevision(id);
  }

  /**
   * A file the page design `id` names (`pageDesignAssets`), from the blob store or, the old
   * layout, `assets/<hash>` in the repository (#554); `undefined` when the design names no such
   * file or it is not there. Designs carry no audience: every reader of the commit reads the
   * files they name. `read: false` only asks whether it is there (no bytes: an empty array).
   */
  async pageDesignAsset(
    id: string,
    hash: string,
    { read = true }: { read?: boolean } = {},
  ): Promise<Uint8Array | undefined> {
    const design = await this.#raw.pageDesign(id);
    if (
      !design ||
      !pageDesignAssets(design).some((a) => a.asset === `sha256:${hash}`)
    ) {
      return undefined;
    }
    if (read) return this.#raw.asset(hash);
    return (await this.#raw.hasAsset(hash)) ? new Uint8Array() : undefined;
  }

  /**
   * Every term at this commit, by ID, and the files that are no term (with
   * why). Terms carry no audience: every reader of the commit reads them
   * all, in every language (#135).
   */
  async terms(): Promise<TermListing[]> {
    const ids = await this.#raw.terms();
    const listed = await mapAtMost(
      ids,
      FILES_AT_ONCE,
      async (id): Promise<TermListing | undefined> => {
        try {
          const term = await this.#raw.term(id);
          return term && { id, term };
        } catch (error) {
          if (!(error instanceof InvalidContentError)) throw error;
          return { id, error: error.message };
        }
      },
    );
    return listed.filter((entry) => entry !== undefined);
  }

  /**
   * A term, `undefined` when there is none (or the ID is no term ID); a
   * file that is no term throws `InvalidContentError`. Every reader of the
   * commit reads it (`terms`).
   */
  term(id: string): Promise<Term | undefined> {
    return this.#raw.term(id);
  }

  /**
   * For checking a change in core, never for a response: every module (in
   * every language) and every manifest at this commit, whether or not the
   * actor may read it, and every term, `'unreadable'` for a broken file,
   * so a check of a configuration change (which content it would make
   * invalid) sees all of it. One at a time, so nothing holds the whole repository at once.
   */
  async *everythingForCheck(): AsyncGenerator<
    | {
        kind: 'module';
        id: string;
        lang: string;
        module: Module | 'unreadable';
      }
    | { kind: 'manual'; id: string; manifest: Manifest | 'unreadable' }
    | { kind: 'term'; id: string; term: Term | 'unreadable' }
    | { kind: 'design'; id: string; design: PageDesign | 'unreadable' }
  > {
    const unreadable = async <T>(read: () => Promise<T>) => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof InvalidContentError) return 'unreadable' as const;
        throw error;
      }
    };
    for (const { id, lang } of await this.#raw.modules()) {
      const module = await unreadable(() => this.#raw.module(id, lang));
      if (module !== undefined) yield { kind: 'module', id, lang, module };
    }
    for (const id of await this.#raw.manifests()) {
      const manifest = await unreadable(() => this.#raw.manifest(id));
      if (manifest !== undefined) yield { kind: 'manual', id, manifest };
    }
    for (const id of await this.#raw.terms()) {
      const source = await this.termSource(id);
      if (source === undefined) continue;
      let term: Term | 'unreadable';
      try {
        term = parseTerm(source, { id });
      } catch (error) {
        if (!(error instanceof TermParseError)) throw error;
        term = 'unreadable';
      }
      yield { kind: 'term', id, term };
    }
    for (const id of await this.#raw.pageDesigns()) {
      const design = await unreadable(() => this.#raw.pageDesign(id));
      if (design !== undefined) yield { kind: 'design', id, design };
    }
  }

  /**
   * Per file reference a module the actor may see makes in an image or
   * attachment block (`sha256:<hash>` as the module writes it, unchecked),
   * the modules showing or attaching it, ordered
   * by module ID and language; the references in the order of their first
   * module. Only what the actor may see: an image only modules outside the
   * scope show is not there, and no use outside it is listed.
   */
  assetUsage(): Promise<ReadonlyMap<string, readonly AssetUse[]>> {
    return this.#referencedAssets();
  }

  /**
   * Every attachment block (#236) of the modules the actor may see, nested ones too, by module
   * ID, language and block order (#139, the download centre). Only what the actor may see: a
   * block in a module outside their scope is not there. Worked out once per commit and reading
   * key (`attachmentListings`); the list is the caller's, its entries are shared.
   */
  async attachments(): Promise<AttachmentUse[]> {
    // Drafts change between two reads of the same commit: never kept.
    if (this.#overlaid) return this.#listAttachments();
    return [
      ...(await attachmentListings.get(
        `${this.commit}|${this.readingKey}`,
        () => this.#listAttachments(),
      )),
    ];
  }

  async #listAttachments(): Promise<AttachmentUse[]> {
    const shown = (await this.modules())
      .flatMap((entry) => ('module' in entry ? [entry] : []))
      .sort((a, b) => compare(a.id, b.id) || compare(a.lang, b.lang));
    const found: AttachmentUse[] = [];
    for (const { id, lang, module } of shown) {
      for (const { kind, node } of walk(module.blocks)) {
        if (kind !== 'block' || node.type !== 'attachment') continue;
        found.push({
          moduleId: id,
          lang,
          title: module.meta.title,
          facets: module.meta.facets ?? {},
          block: node,
        });
      }
    }
    return found;
  }

  /** Whether a module the actor may see refers to the file `sha256:<hash>` (the reading scope of assets). */
  async refersToAsset(hash: string): Promise<boolean> {
    return (await this.#referencedAssets()).has(`sha256:${hash}`);
  }

  /** A file of the old layout, when a module the actor may see refers to it. */
  async asset(hash: string): Promise<Uint8Array | undefined> {
    const referenced = await this.#referencedAssets();
    return referenced.has(`sha256:${hash}`) ? this.#raw.asset(hash) : undefined;
  }

  /**
   * The configured safety symbols that have artwork at this commit, by ID:
   * the repository path of the artwork (`symbols/<id>.png` or `.svg`, the PNG when both exist: the PDF's pick).
   * Symbols are configuration: not scoped, every reader of the commit sees
   * them (#208). A file for an ID the configuration does not hold is not
   * listed.
   */
  async symbolArtwork(): Promise<ReadonlyMap<string, string>> {
    const [config, files] = await Promise.all([
      this.#raw.config(),
      this.#raw.symbols(),
    ]);
    const found = new Map<string, string>();
    for (const { id } of config.safetySymbols) {
      const path = files.get(id);
      if (path !== undefined) found.set(id, path);
    }
    return found;
  }

  /** A configured safety symbol's artwork, or undefined when it has none (`symbolArtwork`). */
  async symbolFile(
    id: string,
  ): Promise<{ path: string; bytes: Uint8Array } | undefined> {
    const path = (await this.symbolArtwork()).get(id);
    if (path === undefined) return undefined;
    const bytes = await this.#raw.file(path);
    return bytes === undefined ? undefined : { path, bytes };
  }

  /**
   * What the renderer may read for a manual this object resolved: the
   * repository's template and safety symbols, and the images that manual
   * refers to; nothing else.
   */
  renderSource(resolution: ManualResolution): RenderSource {
    if (!this.#resolved.has(resolution)) {
      throw new Error('renderSource needs a manual resolved by this content');
    }
    const raw = this.#raw;
    const images = new Set<string>();
    for (const blocks of entryBlocks(resolution.manual.entries)) {
      addImages(blocks, images);
    }
    // The page design's files (#391): its logo, cover image, fonts and the images in its regions.
    for (const file of designFiles(resolution)) images.add(file);
    let symbols: ReturnType<RenderSource['symbols']> | undefined;
    const symbolsOnce = () => (symbols ??= raw.symbols());
    return {
      commit: raw.commit,
      symbols: symbolsOnce,
      template: () => raw.template(),
      // Only the template the manual's design names (#396), nothing else of `templates/`.
      designTemplate: () =>
        resolution.design?.template === undefined
          ? Promise.resolve(undefined)
          : raw.designTemplate(resolution.design.template),
      committedAt: () => raw.committedAt(),
      asset: async (hash) =>
        images.has(`sha256:${hash}`) ? raw.asset(hash) : undefined,
      hasAsset: async (hash) =>
        images.has(`sha256:${hash}`) && raw.hasAsset(hash),
      file: async (path) =>
        [...(await symbolsOnce()).values()].includes(path)
          ? raw.file(path)
          : undefined,
    };
  }

  #sees(module: Module, config: ProjectConfig): boolean {
    return allows(
      this.#actor,
      this.permission,
      moduleTarget(module.meta, config),
    );
  }

  /** A manifest as the actor may read it: `#named`, then validated. */
  async #readable(
    manifest: Manifest,
    config: ProjectConfig,
    mayName?: (id: string) => Promise<boolean>,
  ): Promise<ReadableManual> {
    const named = await this.#named(manifest, config, mayName);
    const issues: ManualIssue[] = validateManifest(named.manifest, config);
    // What gathering a derived manual here found (#451; not for a manifest of another
    // commit), naming only modules the actor may name.
    if (!mayName) {
      const found = await this.#raw.derivationIssues(manifest.id);
      for (const issue of found) {
        if (issue.code === 'empty-derived-manual') continue;
        if (issue.at === undefined || (await this.#mayName(issue.at, config))) {
          issues.push(issue);
        }
      }
      // Gathering nothing the actor may see is gathering nothing, for them: whether there
      // was something hidden does not show.
      const rule = named.manifest.rule;
      const own = new Set(rule ? [...rule.front, ...rule.back] : []);
      if (
        rule &&
        !found.some((i) => i.severity === 'error') &&
        ![...manifestModules(named.manifest.entries)].some((id) => !own.has(id))
      ) {
        issues.push(
          emptyDerivedManual(rule.source, rule.notices !== undefined),
        );
      }
    }
    if (this.#notes()) {
      for (const at of named.left) {
        issues.push({
          severity: 'warning',
          code: 'outside-scope',
          message: OUTSIDE_SCOPE,
          at,
        });
      }
    }
    return { manifest: named.manifest, issues };
  }

  /**
   * The manifest without its references to modules the actor may not see
   * (and the groups that leaves empty), and the IDs of those modules, in
   * the order the manifest names them.
   */
  async #named(
    manifest: Manifest,
    config: ProjectConfig,
    mayName: (id: string) => Promise<boolean> = (id) =>
      this.#mayName(id, config),
  ): Promise<{ manifest: Manifest; left: string[] }> {
    // A derived manual's rule names modules too (#451): its front and back matter, the
    // modules it excludes.
    const rule = manifest.rule;
    const ids = [
      ...new Set([
        ...manifestModules(manifest.entries),
        ...(rule ? [...rule.front, ...rule.exclude, ...rule.back] : []),
      ]),
    ];
    const nameable = new Map(
      await Promise.all(
        ids.map(async (id) => [id, await mayName(id)] as const),
      ),
    );
    const left = ids.filter((id) => !nameable.get(id));
    if (left.length === 0) return { manifest, left };
    const keep = (entries: readonly ManifestEntry[]): ManifestEntry[] =>
      entries.flatMap((entry): ManifestEntry[] => {
        if ('module' in entry) return nameable.get(entry.module) ? [entry] : [];
        const kept = keep(entry.entries);
        return kept.length ? [{ ...entry, entries: kept }] : [];
      });
    const named = (list: readonly string[]) =>
      list.filter((id) => nameable.get(id));
    return {
      manifest: {
        ...manifest,
        entries: keep(manifest.entries),
        ...(rule && {
          rule: {
            ...rule,
            front: named(rule.front),
            exclude: named(rule.exclude),
            back: named(rule.back),
          },
        }),
      },
      left,
    };
  }

  /**
   * `#mayName` for a manifest of another commit (an older version, a
   * deleted manual's last manifest): a module with no file here may have
   * been one outside the actor's scope when that manifest named it, so it
   * is named only to an actor from whom nothing is hidden.
   */
  async #mayNameFromThen(id: string, config: ProjectConfig): Promise<boolean> {
    if (!(await this.#moduleFiles()).has(id)) return this.#seesEverything();
    return this.#mayName(id, config);
  }

  /**
   * Whether a manifest may name a module to the actor: the actor may see it
   * in some language (a broken file: may read everything in its language),
   * or it exists in none, so naming it hides nothing. An actor from whom
   * nothing is hidden may have every module named without one being read
   * (#478: listing the manuals otherwise parses every module they name).
   */
  #mayName(id: string, config: ProjectConfig): Promise<boolean> {
    if (this.#seesEverything()) return Promise.resolve(true);
    let found = this.#nameable.get(id);
    if (!found) {
      found = this.#nameableIn(this, id, config);
      this.#nameable.set(id, found);
    }
    return found;
  }

  /** `#mayName` over the module's files in `source`, with this permission. */
  async #nameableIn(
    source: ReadableContent,
    id: string,
    config: ProjectConfig,
  ): Promise<boolean> {
    const langs = (await source.#moduleFiles()).get(id) ?? [];
    if (langs.length === 0) return true;
    for (const lang of langs) {
      try {
        const module = await source.#raw.module(id, lang);
        if (module ? this.#sees(module, config) : this.#seesAllIn(lang)) {
          return true;
        }
      } catch (error) {
        if (!(error instanceof InvalidContentError)) throw error;
        if (this.#seesAllIn(lang)) return true;
      }
    }
    return false;
  }

  /** Module ID → the languages it has a file in. */
  #moduleFiles(): Promise<Map<string, string[]>> {
    return (this.#files ??= this.#raw.modules().then((files) => {
      const byId = new Map<string, string[]>();
      for (const { id, lang } of files) {
        const langs = byId.get(id);
        if (langs) langs.push(lang);
        else byId.set(id, [lang]);
      }
      return byId;
    }));
  }

  /** Whether the actor is told what was left out (`outside-scope`). */
  #notes(): boolean {
    return allows(this.#actor, 'content.read.draft', ANYWHERE);
  }

  #seesAllIn(lang: string): boolean {
    return allowsAllIn(this.#actor, this.permission, lang);
  }

  #seesManual(
    audience: string | undefined,
    lang: string | undefined,
    config: ProjectConfig,
  ): boolean {
    return allowsManual(this.#actor, this.permission, {
      audiences: config.audiences.map((a) => a.id),
      audience,
      lang,
    });
  }

  /** A manual whose audience is unknown: only for one who sees every level. */
  #seesEveryManual(config: ProjectConfig): boolean {
    return this.#seesManual(undefined, undefined, config);
  }

  /**
   * The issues of a resolution, as far as the actor may learn them: nothing
   * about a module left out (by resolving, or from the manifest: `unnamed`)
   * but that it was (for `content.read.draft` holders only), and a broken
   * module's error only for one who may read
   * everything in the languages it was looked up in.
   */
  #readableIssues(
    { issues, manual }: ManualResolution,
    unnamed: readonly string[],
    lang: string,
    config: ProjectConfig,
  ): ManualResolution['issues'] {
    // Listed as an entry, or inlined (its blocks have origins).
    const included = new Set(
      Object.values(manual.origins).map((origin) => origin.module),
    );
    for (const id of entryModules(manual.entries)) included.add(id);
    const seesBroken =
      this.#seesAllIn(lang) && this.#seesAllIn(config.languages.source);
    // Left out of the manifest: nothing about it, whatever resolving found.
    const hidden = new Set<string>(unnamed);
    for (const issue of issues) {
      if (issue.module === undefined) continue;
      if (issue.code === 'outside-scope') hidden.add(issue.module);
      // A broken file left the module out unless a fallback stood in.
      if (
        issue.code === 'invalid-module' &&
        !seesBroken &&
        !included.has(issue.module)
      ) {
        hidden.add(issue.module);
      }
    }
    const notes = this.#notes();
    const kept = issues.filter(
      (issue) =>
        issue.module === undefined ||
        (!hidden.has(issue.module) &&
          (notes || issue.code !== 'missing-module') &&
          (seesBroken || issue.code !== 'invalid-module')),
    );
    if (!notes) return kept;
    return [
      ...kept,
      ...[...hidden].map((module) => ({
        severity: 'warning' as const,
        code: 'outside-scope' as const,
        message: OUTSIDE_SCOPE,
        module,
      })),
    ];
  }

  /** Every `sha256:…` image reference in the modules the actor may see, with those modules. */
  #referencedAssets(): Promise<ReadonlyMap<string, readonly AssetUse[]>> {
    // Drafts change between two reads of the same commit: never kept.
    if (this.#overlaid) return (this.#overlayAssets ??= this.#collectAssets());
    const key = `${this.commit}|${this.readingKey}`;
    let found = referencedAssets.get(key);
    if (!found) {
      found = this.#collectAssets();
      // Not kept when it fails, so a passing error is not remembered.
      found.catch(() => referencedAssets.delete(key));
      referencedAssets.set(key, found);
      if (referencedAssets.size > REFERENCED_ASSETS_KEPT) {
        const oldest = referencedAssets.keys().next().value;
        if (oldest !== undefined) referencedAssets.delete(oldest);
      }
    }
    return found;
  }

  async #collectAssets(): Promise<ReadonlyMap<string, readonly AssetUse[]>> {
    const shown = (await this.modules())
      .flatMap((entry) => ('module' in entry ? [entry] : []))
      .sort((a, b) => compare(a.id, b.id) || compare(a.lang, b.lang));
    const found = new Map<string, AssetUse[]>();
    for (const { id, lang, module } of shown) {
      for (const [asset, used] of assetDescriptions(module.blocks)) {
        const use = {
          moduleId: id,
          lang,
          title: module.meta.title,
          ...used,
          searchText: [id, module.meta.title, ...used.descriptions]
            .map(foldKeyword)
            .join('\n'),
        };
        const uses = found.get(asset);
        if (uses) uses.push(use);
        else found.set(asset, [use]);
      }
    }
    return found;
  }
}

function* manifestModules(
  entries: readonly ManifestEntry[],
): Generator<string> {
  for (const entry of entries) {
    if ('module' in entry) yield entry.module;
    else yield* manifestModules(entry.entries);
  }
}

function* entryModules(entries: readonly ResolvedEntry[]): Generator<string> {
  for (const entry of entries) {
    if (entry.kind === 'group') yield* entryModules(entry.entries);
    else yield entry.module;
  }
}

function* entryBlocks(entries: readonly ResolvedEntry[]): Generator<Block[]> {
  for (const entry of entries) {
    if (entry.kind === 'group') yield* entryBlocks(entry.entries);
    else yield entry.blocks;
  }
}

/** Code-unit order, so the result does not depend on the locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Adds the asset of every image in `blocks` (nested ones too) to `found`:
 * what a PDF embeds. Attachments are not: a PDF cannot carry the file.
 */
/**
 * The files a manual's page design names (#391): its logo, cover image, fonts and the images
 * in its regions (`sha256:<hash>`, each once, sorted); none without a design.
 */
export function designFiles(resolution: ManualResolution): string[] {
  const design = resolution.design;
  if (!design) return [];
  const files = new Set<string>();
  for (const file of [
    design.logo?.light,
    design.logo?.dark,
    design.coverImage?.asset,
    ...[design.fonts.body, design.fonts.heading].flatMap((font) =>
      font ? [font.regular, font.bold, font.italic, font.boldItalic] : [],
    ),
  ]) {
    if (file) files.add(file);
  }
  for (const blocks of Object.values(design.regions)) addImages(blocks, files);
  return [...files].sort();
}

function addImages(blocks: readonly Block[], found: Set<string>): void {
  for (const { kind, node } of walk(blocks)) {
    if (kind === 'block' && node.type === 'image') found.add(node.asset);
  }
}

interface AssetDescription {
  descriptions: string[];
  asImage: boolean;
  fileNames: string[];
}

/**
 * Per file in `blocks` (nested ones too) that an image shows or an
 * attachment attaches: the alt texts and titles (plain text) of the image
 * blocks and the names, descriptions and file names of the attachment
 * blocks, in block order, whether an image shows it, and the attachments'
 * file names.
 */
function assetDescriptions(
  blocks: readonly Block[],
): Map<string, AssetDescription> {
  const found = new Map<string, AssetDescription>();
  const of = (asset: string) => {
    let entry = found.get(asset);
    if (!entry) {
      entry = { descriptions: [], asImage: false, fileNames: [] };
      found.set(asset, entry);
    }
    return entry;
  };
  for (const { kind, node } of walk(blocks)) {
    if (kind !== 'block') continue;
    if (node.type === 'image') {
      const entry = of(node.asset);
      entry.asImage = true;
      entry.descriptions.push(node.alt);
      const title = plainText(node.title);
      if (title) entry.descriptions.push(title);
    } else if (node.type === 'attachment') {
      const entry = of(node.asset);
      entry.fileNames.push(node.fileName);
      entry.descriptions.push(node.name);
      if (node.description) entry.descriptions.push(node.description);
      entry.descriptions.push(node.fileName);
    }
  }
  return found;
}

/** The text of a run of inline content, without its marks. */
function plainText(content: readonly Inline[] | undefined): string {
  return (content ?? [])
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'xref':
          return node.text?.map((run) => run.text).join('') ?? '';
        case 'kbd':
          return node.keys.join('+');
        case 'hardBreak':
          return ' ';
        case 'attribute':
          // Its value depends on the variant.
          return '';
        case 'placeholder':
        case 'calloutRef':
          // A placeholder is a page design's value, never in a module (a validation error); a
          // callout reference's number depends on the variant.
          return '';
        default:
          node satisfies never;
          return '';
      }
    })
    .join('');
}

/** Whether `path` is a page design template's text file (#396): `templates/<id>/<path>`. */
function isTemplateFileSource(path: string): boolean {
  const match = /^templates\/([a-z0-9]+(?:-[a-z0-9]+)*)\/(.+)$/.exec(path);
  return (
    match !== null &&
    isTemplateFilePath(match[2] as string) &&
    isTemplateTextFile(match[2] as string)
  );
}
