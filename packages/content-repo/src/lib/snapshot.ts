import {
  AsciidocParseError,
  CONFIG_FILE_NAME,
  LEGACY_CONFIG_FILE_NAME,
  deriveManifest,
  DESIGN_TEMPLATES_DIR,
  DesignTemplateId,
  designTemplateDir,
  designTemplatePath,
  isTemplateFilePath,
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_FILES,
  readGatheringModules,
  type DeriveResult,
  LanguageTag,
  isTermId,
  linkedTermIds,
  ModuleId,
  crossReferencedModules,
  parseManifest,
  parseModule,
  parseTerm,
  parsePageDesign,
  type PageDesign,
  PageDesignId,
  parseTranslationRecord,
  ProjectConfig,
  resolveManual,
  sourceModuleIds,
  walk,
  type Manifest,
  type ManifestEntry,
  type Module,
  type ResolveResult,
  type Term,
  type TranslationRecord,
  type VariantValues,
} from '@openfolia/content-model';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  DEFAULT_INDEX_CACHE_BYTES,
  ENTRY_BYTES,
  GitRepo,
  MODULE_LISTINGS_SHARE,
  stringBytes,
  type PathVersion,
} from './git.js';
import { Lru } from './lru.js';

/** Where things live in a content repository. */
export const LAYOUT = {
  /** `openfolia.yaml` (`CONFIG_FILE_NAME`) */
  config: CONFIG_FILE_NAME,
  /**
   * Compatibility, for one release: `ccms.yaml` (`LEGACY_CONFIG_FILE_NAME`), read with a
   * deprecation warning when `config` is missing, ignored when both exist.
   */
  legacyConfig: LEGACY_CONFIG_FILE_NAME,
  /**
   * `modules/<lang>/<id>.adoc`, and next to a translated module its
   * translation record, `modules/<lang>/<id>.translation.yaml`
   */
  modules: 'modules',
  /** `manuals/<id>.yaml` */
  manuals: 'manuals',
  /** `terms/<id>.yaml`: one term each (its format is the content model's `Term`) */
  terms: 'terms',
  /** `design/<id>.yaml`: page designs (#390; the content model's `PageDesign`) */
  designs: 'design',
  /** `assets/<sha256 hex>`: content-addressed images */
  assets: 'assets',
  /** `symbols/<id>.svg` or `.png` */
  symbols: 'symbols',
  /** Optional Typst template replacing the built-in one. */
  template: 'templates/manual.typ',
  /**
   * `templates/<id>/`: an organisation's own template a page design names (#396), its entry
   * `manual.typ` (the content model's `designTemplatePath`).
   */
  templates: DESIGN_TEMPLATES_DIR,
} as const;

/** A file in the repository that exists but is not valid. */
export class ContentError extends Error {
  constructor(
    readonly path: string,
    message: string,
    /**
     * A stable code for why, when the parser named one: `table-too-large`, a table past
     * `MAX_TABLE_COLUMNS` or `MAX_TABLE_CELLS` (#686).
     */
    readonly code?: 'table-too-large' | 'template-too-large',
  ) {
    super(`${path}: ${message}`);
    this.name = 'ContentError';
  }
}

/** A parsed file, or why it cannot be; `weight`: the bytes it is kept as (its text and key). */
type Parsed = ({ value: unknown } | { error: ContentError }) & {
  readonly weight: number;
};

/** What a parsed file is kept under: its blob ID and path (`<blob>:<path>`). */
type ParsedKey = string;

/** Bytes of file text the parsed files kept stand for, by default (`ContentRepoOptions`). */
export const DEFAULT_PARSED_CACHE_BYTES = 64 * 1024 * 1024;

export interface ContentRepoOptions {
  /**
   * How much parsed content is kept, in bytes of the files' text (a parsed
   * module takes about five to six times its text in memory). Default
   * `DEFAULT_PARSED_CACHE_BYTES`.
   */
  readonly parsedCacheBytes?: number;
  /**
   * How many bytes the indexes of the repository take at most (`GitRepoOptions`), the module
   * listings per commit included (`MODULE_LISTINGS_SHARE`). Default `DEFAULT_INDEX_CACHE_BYTES`.
   */
  readonly indexCacheBytes?: number;
}

/** A commit's module files kept (`ContentRepo.moduleFiles`): weighed once listed. */
interface ModuleListing {
  readonly files: Promise<readonly ModuleFile[]>;
  readonly bytes: number;
}

/** A content repository; `at(ref)` gives a consistent view of one commit. */
export class ContentRepo {
  /**
   * Parsed files by blob ID and path (`<blob>:<path>`), weighed by their
   * text: a file's blob never changes, so the same file at many commits
   * (and in history reads) is parsed once, and what is kept is immutable,
   * so safe to share.
   */
  readonly parsed: Lru<Parsed>;
  /** Parses in flight by `commit:path` or `<blob>:<path>`, shared by their callers. */
  readonly #parsing = new Map<string, Promise<Parsed | undefined>>();

  constructor(
    readonly git: GitRepo,
    options: ContentRepoOptions = {},
  ) {
    this.parsed = new Lru<Parsed>(
      options.parsedCacheBytes ?? DEFAULT_PARSED_CACHE_BYTES,
      (entry) => entry.weight,
    );
    this.#moduleFiles = new Lru<ModuleListing>(
      Math.floor(
        (options.indexCacheBytes ?? DEFAULT_INDEX_CACHE_BYTES) *
          MODULE_LISTINGS_SHARE,
      ),
      (listing, key) => stringBytes(key) + listing.bytes,
      // The newest commit's listing is kept however many modules it holds.
      { pinOversized: () => 'modules' },
    );
  }

  static open(dir: string, options: ContentRepoOptions = {}): ContentRepo {
    return new ContentRepo(
      new GitRepo(
        dir,
        undefined,
        options.indexCacheBytes === undefined
          ? {}
          : { indexCacheBytes: options.indexCacheBytes },
      ),
      options,
    );
  }

  /** The module files at a commit (`Snapshot.modules`), listed once per commit, by bytes. */
  readonly #moduleFiles: Lru<ModuleListing>;

  /** The legacy configuration warnings given (`warnLegacyConfig`): each once per repository. */
  readonly #legacyConfigWarned = new Set<'read' | 'ignored'>();

  /**
   * Whether `ccms.yaml` is beside `openfolia.yaml` at a commit, while that has not been warned
   * about yet: after the warning, never looked at again. Its ID is kept by the Git index, so a
   * commit is looked at once.
   */
  async legacyConfigBeside(commit: string): Promise<boolean> {
    if (this.#legacyConfigWarned.has('ignored')) return false;
    const known = this.git.knownFileId(commit, LAYOUT.legacyConfig);
    if (known !== undefined) return known !== null;
    return (
      (await this.git.readFileWithId(commit, LAYOUT.legacyConfig)) !== undefined
    );
  }

  /**
   * Compatibility, for one release: a Node deprecation warning (`OPENFOLIA_LEGACY_CONFIG`), once
   * per repository and case, that the configuration was read from `ccms.yaml` (`read`) or that a
   * `ccms.yaml` beside `openfolia.yaml` is ignored (`ignored`).
   */
  warnLegacyConfig(kind: 'read' | 'ignored'): void {
    if (this.#legacyConfigWarned.has(kind)) return;
    this.#legacyConfigWarned.add(kind);
    process.emitWarning(
      kind === 'read'
        ? `The configuration is read from ${LAYOUT.legacyConfig}, its name before the product was named. Rename it to ${LAYOUT.config}: the old name is read for one more release only.`
        : `${LAYOUT.legacyConfig} is ignored: ${LAYOUT.config} is beside it and wins. Delete ${LAYOUT.legacyConfig}.`,
      { type: 'DeprecationWarning', code: 'OPENFOLIA_LEGACY_CONFIG' },
    );
  }

  /** The bytes the module listings keep now, and at most. @internal For tests. */
  moduleListingsWeight(): { bytes: number; capacity: number; pinned: number } {
    return {
      bytes: this.#moduleFiles.weight,
      capacity: this.#moduleFiles.capacity,
      pinned: this.#moduleFiles.pinnedWeight,
    };
  }

  /**
   * The module files at `commit`, from `list` the first time (a failure is not kept).
   * @internal For `Snapshot`.
   */
  moduleFiles(
    commit: string,
    list: () => Promise<readonly ModuleFile[]>,
  ): Promise<readonly ModuleFile[]> {
    const kept = this.#moduleFiles.get(commit);
    if (kept) return kept.files;
    const listing: ModuleListing = { files: list(), bytes: ENTRY_BYTES };
    this.#moduleFiles.set(commit, listing);
    listing.files.then(
      (files) => {
        // Weighed again once listed (if still kept): each file's ID and language.
        if (this.#moduleFiles.get(commit) !== listing) return;
        const bytes = files.reduce(
          (n, f) => n + stringBytes(f.id) + stringBytes(f.lang) + ENTRY_BYTES,
          ENTRY_BYTES,
        );
        this.#moduleFiles.set(commit, { files: listing.files, bytes });
      },
      () => {
        if (this.#moduleFiles.get(commit) === listing) {
          this.#moduleFiles.delete(commit);
        }
      },
    );
    return listing.files;
  }

  /**
   * The parse `key` names, made once by `make` however many callers ask at
   * once (a list read by many requests together parses each file once).
   * @internal For `Snapshot`.
   */
  shared(
    key: string,
    make: () => Promise<Parsed | undefined>,
  ): Promise<Parsed | undefined> {
    let found = this.#parsing.get(key);
    if (!found) {
      found = make().finally(() => this.#parsing.delete(key));
      this.#parsing.set(key, found);
    }
    return found;
  }

  /** A snapshot at a branch, tag or commit, or undefined if the ref does not exist. */
  async at(ref: string): Promise<Snapshot | undefined> {
    const commit = await this.git.resolveRef(ref);
    return commit ? new Snapshot(this, commit) : undefined;
  }

  /**
   * A snapshot at each of several branches, tags or commits, as `at` gives one (undefined where
   * the ref does not exist), in the order given, from one ref listing (`GitRepo.resolveRefs`):
   * for reading many tags at once (#764).
   */
  async atEach(refs: readonly string[]): Promise<(Snapshot | undefined)[]> {
    const commits = await this.git.resolveRefs(refs);
    return commits.map((commit) =>
      commit ? new Snapshot(this, commit) : undefined,
    );
  }

  close(): void {
    this.git.close();
  }
}

export interface ModuleFile {
  id: string;
  lang: string;
}

export interface ManualResolution extends ResolveResult {
  config: ProjectConfig;
  manifest: Manifest;
}

/** A version of a module's file (`Snapshot.moduleHistory`). */
export interface ModuleVersion extends Omit<PathVersion, 'blob'> {
  /** The file's revision after the commit (its blob ID); undefined when it deleted the file. */
  readonly revision?: string;
}

/** A module file deleted on a first-parent line and not there now (`Snapshot.deletedModules`). */
export interface DeletedModuleFile {
  readonly id: string;
  readonly lang: string;
  /** The file's revision before its deletion (its blob ID): the module as it last was. */
  readonly revision: string;
  /** The commit that deleted it (its newest deletion). */
  readonly commit: string;
  /** When that commit was committed (ISO 8601). */
  readonly committedAt: string;
}

/** The module files deleted on a first-parent line, newest deletion first. */
export interface DeletedModules {
  readonly files: readonly DeletedModuleFile[];
  /** Whether the line goes on past the commits looked at. */
  readonly truncated: boolean;
}

/** A manifest deleted on a first-parent line and not there now (`Snapshot.deletedManifests`). */
export interface DeletedManifest {
  readonly id: string;
  /** The file's revision before its deletion (its blob ID): the manifest as it last was. */
  readonly revision: string;
  /** The commit that deleted it (its newest deletion). */
  readonly commit: string;
  /** When that commit was committed (ISO 8601). */
  readonly committedAt: string;
}

/** The manifests deleted on a first-parent line, newest deletion first. */
export interface DeletedManifests {
  readonly files: readonly DeletedManifest[];
  /** Whether the line goes on past the commits looked at. */
  readonly truncated: boolean;
}

/** The versions of a module's file (or a manifest, `Snapshot.manifestHistory`) on a first-parent line, newest first. */
export interface ModuleHistory {
  readonly versions: readonly ModuleVersion[];
  /** Whether the line goes on past the commits looked at. */
  readonly truncated: boolean;
  /** When truncated: the file's revision just before the oldest commit looked at, if it had one. */
  readonly before?: string;
}

export class Snapshot {
  constructor(
    private readonly repo: ContentRepo,
    readonly commit: string,
  ) {}

  /**
   * The configuration: `openfolia.yaml`, else (for one release) `ccms.yaml` with a deprecation
   * warning (`ContentRepo.warnLegacyConfig`). With both, `openfolia.yaml` wins.
   */
  async config(): Promise<ProjectConfig> {
    const parse = (text: string) => check(ProjectConfig, parseYaml(text));
    const config = await this.parsed(LAYOUT.config, parse);
    if (config) {
      if (await this.repo.legacyConfigBeside(this.commit)) {
        this.repo.warnLegacyConfig('ignored');
      }
      return config;
    }
    const legacy = await this.parsed(LAYOUT.legacyConfig, parse);
    if (!legacy) throw new ContentError(LAYOUT.config, 'missing');
    this.repo.warnLegacyConfig('read');
    return legacy;
  }

  /** A module in a language; undefined if there is no such file (or the ID or language is invalid). */
  async module(id: string, lang: string): Promise<Module | undefined> {
    if (!isModuleId(id) || !isCanonicalLang(lang)) return undefined;
    const path = `${LAYOUT.modules}/${lang}/${id}.adoc`;
    return this.parsed(path, (text) => parseModuleFile(text, id, lang));
  }

  /**
   * The versions of a module's file on this commit's first-parent line
   * (`GitRepo.pathHistory`: the commits among the newest `max` that
   * changed it, newest first, a merge counting when it brought a change
   * in), each with the file's revision after it (`moduleRevision` there;
   * undefined: deleted). No versions for an invalid ID or language.
   */
  async moduleHistory(
    id: string,
    lang: string,
    max: number,
  ): Promise<ModuleHistory> {
    if (!isModuleId(id) || !isCanonicalLang(lang)) {
      return { versions: [], truncated: false };
    }
    const path = `${LAYOUT.modules}/${lang}/${id}.adoc`;
    const history = await this.repo.git.pathHistory(this.commit, path, max);
    return {
      versions: history.versions.map(({ blob, ...version }) => ({
        ...version,
        ...(blob !== undefined && { revision: blob }),
      })),
      truncated: history.truncated,
      ...(history.before !== undefined && { before: history.before }),
    };
  }

  /**
   * The module files (`.adoc`) deleted among the newest `max` commits of
   * this commit's first-parent line and not there at this commit
   * (`GitRepo.deletedFiles`), each with its revision before its newest
   * deletion (read it with `moduleAtRevision`). Newest deletion first; a
   * module deleted before the commits looked at is not listed.
   */
  async deletedModules(max: number): Promise<DeletedModules> {
    const found = await this.repo.git.deletedFiles(
      this.commit,
      LAYOUT.modules,
      max,
    );
    return {
      files: found.files.flatMap(({ path, blob, commit, committedAt }) => {
        const m = /^modules\/([^/]+)\/([^/]+)\.adoc$/.exec(path);
        if (!m || !isCanonicalLang(m[1] ?? '') || !isModuleId(m[2] ?? '')) {
          return [];
        }
        return [
          {
            id: m[2] as string,
            lang: m[1] as string,
            revision: blob,
            commit,
            committedAt,
          },
        ];
      }),
      truncated: found.truncated,
    };
  }

  /**
   * The module as stored in the file revision `revision` (a blob ID, from
   * `moduleRevision` or `moduleHistory`), read as its file in `lang`;
   * undefined when there is no such blob (or the ID or language is
   * invalid). Throws `ContentError` when it cannot be read, as `module`
   * does.
   */
  async moduleAtRevision(
    id: string,
    lang: string,
    revision: string,
  ): Promise<Module | undefined> {
    if (!isModuleId(id) || !isCanonicalLang(lang)) return undefined;
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision)) return undefined;
    const path = `${LAYOUT.modules}/${lang}/${id}.adoc`;
    return this.parsedBlob(revision, path, (text) =>
      parseModuleFile(text, id, lang),
    );
  }

  /**
   * The Git blob ID of a module's file, or undefined if there is none (or
   * the ID or language is invalid): equal IDs, equal files, at any commits.
   */
  async moduleRevision(id: string, lang: string): Promise<string | undefined> {
    if (!isModuleId(id) || !isCanonicalLang(lang)) return undefined;
    const ids = await this.repo.git.fileIds(this.commit, LAYOUT.modules);
    return ids.get(`${LAYOUT.modules}/${lang}/${id}.adoc`);
  }

  /**
   * The translation record of a module's file in a target language
   * (`modules/<lang>/<id>.translation.yaml`): what each block was
   * translated from. Undefined if there is none (or the ID or language is
   * invalid); a file that is no record throws `ContentError`.
   */
  async translationRecord(
    id: string,
    lang: string,
  ): Promise<TranslationRecord | undefined> {
    if (!isModuleId(id) || !isCanonicalLang(lang)) return undefined;
    return this.parsed(
      `${LAYOUT.modules}/${lang}/${id}.translation.yaml`,
      parseTranslationRecord,
    );
  }

  /** The module files (`.adoc`; translation records are not modules). */
  async modules(lang?: string): Promise<ModuleFile[]> {
    const all = await this.repo.moduleFiles(this.commit, async () => {
      const files = await this.repo.git.listFiles(this.commit, LAYOUT.modules);
      return files.flatMap((path) => {
        const m = /^modules\/([^/]+)\/([^/]+)\.adoc$/.exec(path);
        if (!m || !isCanonicalLang(m[1] ?? '') || !isModuleId(m[2] ?? ''))
          return [];
        return [{ id: m[2] as string, lang: m[1] as string }];
      });
    });
    return all
      .filter((file) => lang === undefined || file.lang === lang)
      .map((file) => ({ ...file }));
  }

  async manifest(id: string): Promise<Manifest | undefined> {
    if (!isModuleId(id)) return undefined;
    return this.parsed(`${LAYOUT.manuals}/${id}.yaml`, (text) =>
      parseManifest(text, { id }),
    );
  }

  /**
   * A derived manual's manifest (#451) with its entries gathered from its source manual at this
   * commit (`deriveManifest`: the source's modules are read in the source language for their
   * types; one that cannot be read is not gathered), with the text attributes to resolve it
   * with and what deriving found. An assembled manifest comes back as it is.
   */
  async derive(manifest: Manifest): Promise<DeriveResult> {
    if (manifest.kind !== 'derived' || !manifest.rule) {
      return deriveManifest({
        manifest,
        source: undefined,
        config: { moduleTypes: [], audiences: [] },
        moduleType: () => undefined,
      });
    }
    const config = await this.config();
    let source: Manifest | 'unreadable' | undefined;
    try {
      source = await this.manifest(manifest.rule.source);
    } catch (e) {
      if (!(e instanceof ContentError)) throw e;
      source = 'unreadable';
    }
    let modules = new Map<string, Module>();
    if (source !== undefined && source !== 'unreadable') {
      // A few at a time: a source of thousands of modules does not queue them all at once. A
      // notice gathering (#670) reads the modules referred to too, and the front and back matter.
      const rule = manifest.rule;
      const notices = rule.notices !== undefined;
      modules = await readGatheringModules(
        notices
          ? [...sourceModuleIds(source), ...rule.front, ...rule.back]
          : sourceModuleIds(source),
        async (id) => {
          try {
            return await this.module(id, config.languages.source);
          } catch (e) {
            if (!(e instanceof ContentError)) throw e;
            return undefined;
          }
        },
        { followReferences: notices, atOnce: 32 },
      );
    }
    return deriveManifest({
      manifest,
      source,
      config,
      moduleType: (id) => modules.get(id)?.meta.type,
      module: (id) => modules.get(id),
    });
  }

  /**
   * The Git blob ID of a manual's manifest (`manuals/<id>.yaml`), or
   * undefined if there is none (or the ID is invalid): equal IDs, equal
   * files, at any commits.
   */
  async manifestRevision(id: string): Promise<string | undefined> {
    if (!isModuleId(id)) return undefined;
    const ids = await this.repo.git.fileIds(this.commit, LAYOUT.manuals);
    return ids.get(`${LAYOUT.manuals}/${id}.yaml`);
  }

  /**
   * The versions of a manual's manifest on this commit's first-parent line,
   * as `moduleHistory` gives a module's (`revision`: its blob ID, as
   * `manifestRevision` gives it). No versions for an invalid ID.
   */
  async manifestHistory(id: string, max: number): Promise<ModuleHistory> {
    if (!isModuleId(id)) return { versions: [], truncated: false };
    const path = `${LAYOUT.manuals}/${id}.yaml`;
    const history = await this.repo.git.pathHistory(this.commit, path, max);
    return {
      versions: history.versions.map(({ blob, ...version }) => ({
        ...version,
        ...(blob !== undefined && { revision: blob }),
      })),
      truncated: history.truncated,
      ...(history.before !== undefined && { before: history.before }),
    };
  }

  /**
   * The manifests (`manuals/<id>.yaml`) deleted among the newest `max`
   * commits of this commit's first-parent line and not there at this
   * commit, as `deletedModules` gives the module files (`revision`: the
   * manifest as it last was, for `manifestAtRevision`).
   */
  async deletedManifests(max: number): Promise<DeletedManifests> {
    const found = await this.repo.git.deletedFiles(
      this.commit,
      LAYOUT.manuals,
      max,
    );
    return {
      files: found.files.flatMap(({ path, blob, commit, committedAt }) => {
        const m = /^manuals\/([^/]+)\.yaml$/.exec(path);
        if (!m || !isModuleId(m[1] ?? '')) return [];
        return [{ id: m[1] as string, revision: blob, commit, committedAt }];
      }),
      truncated: found.truncated,
    };
  }

  /**
   * The manifest as stored in the file revision `revision` (a blob ID, from
   * `manifestRevision`, `manifestHistory` or `deletedManifests`), read as
   * `manuals/<id>.yaml`; undefined when there is no such blob (or the ID is
   * invalid). Throws `ContentError` when it cannot be read, as `manifest`
   * does.
   */
  async manifestAtRevision(
    id: string,
    revision: string,
  ): Promise<Manifest | undefined> {
    if (!isModuleId(id)) return undefined;
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision)) return undefined;
    const path = `${LAYOUT.manuals}/${id}.yaml`;
    return this.parsedBlob(revision, path, (text) =>
      parseManifest(text, { id }),
    );
  }

  async manifests(): Promise<string[]> {
    const files = await this.repo.git.listFiles(this.commit, LAYOUT.manuals);
    return files.flatMap((path) => {
      const m = /^manuals\/([^/]+)\.yaml$/.exec(path);
      return m && isModuleId(m[1] ?? '') ? [m[1] as string] : [];
    });
  }

  /** The IDs of the terms (`terms/<id>.yaml`, the ID a valid one), sorted. */
  async terms(): Promise<string[]> {
    const files = await this.repo.git.listFiles(this.commit, LAYOUT.terms);
    return files
      .flatMap((path) => {
        const m = /^terms\/([^/]+)\.yaml$/.exec(path);
        return m && isTermId(m[1] ?? '') ? [m[1] as string] : [];
      })
      .sort();
  }

  /**
   * A term (`terms/<id>.yaml`); undefined if there is no such file (or the
   * ID is no term ID). A file that is no term throws `ContentError`.
   */
  async term(id: string): Promise<Term | undefined> {
    if (!isTermId(id)) return undefined;
    return this.parsed(`${LAYOUT.terms}/${id}.yaml`, (text) =>
      parseTerm(text, { id }),
    );
  }

  /** The IDs of the page designs (`design/<id>.yaml`, the ID a valid one), sorted. */
  async pageDesigns(): Promise<string[]> {
    const files = await this.repo.git.listFiles(this.commit, LAYOUT.designs);
    return files
      .flatMap((path) => {
        const m = /^design\/([^/]+)\.yaml$/.exec(path);
        return m && isPageDesignId(m[1] ?? '') ? [m[1] as string] : [];
      })
      .sort();
  }

  /**
   * A page design (`design/<id>.yaml`, #390); undefined if there is no such file (or the ID
   * is no design ID). A file that is no design throws `ContentError`.
   */
  async pageDesign(id: string): Promise<PageDesign | undefined> {
    if (!isPageDesignId(id)) return undefined;
    return this.parsed(`${LAYOUT.designs}/${id}.yaml`, (text) =>
      parsePageDesign(text, { id }),
    );
  }

  /** An image by its SHA-256 (hex, without the `sha256:` prefix). */
  async asset(hash: string): Promise<Buffer | undefined> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return undefined;
    return this.repo.git.readFile(this.commit, `${LAYOUT.assets}/${hash}`);
  }

  /** Whether `asset(hash)` finds an image, without reading it (the folder's listing, cached). */
  async hasAsset(hash: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return false;
    const ids = await this.repo.git.fileIds(this.commit, LAYOUT.assets);
    return ids.has(`${LAYOUT.assets}/${hash}`);
  }

  /** Safety symbol files by symbol ID → repository path. */
  async symbols(): Promise<Map<string, string>> {
    const files = await this.repo.git.listFiles(this.commit, LAYOUT.symbols);
    const symbols = new Map<string, string>();
    for (const path of files) {
      const m = /^symbols\/([a-z0-9-]+)\.(svg|png)$/.exec(path);
      if (m && !symbols.has(m[1] as string)) symbols.set(m[1] as string, path);
    }
    return symbols;
  }

  async file(path: string): Promise<Buffer | undefined> {
    return this.repo.git.readFile(this.commit, path);
  }

  /** When the commit was made, in whole seconds since the epoch (its committer date). */
  committedAt(): Promise<number> {
    return this.repo.git.committedAt(this.commit);
  }

  /** The repository's Typst template, if it has one. */
  async template(): Promise<string | undefined> {
    const data = await this.repo.git.readFile(this.commit, LAYOUT.template);
    return data ? decode(data, LAYOUT.template) : undefined;
  }

  /**
   * The IDs of the page design templates at this commit (#396): every folder `templates/<id>/`
   * with a `manual.typ`, sorted.
   */
  async designTemplateIds(): Promise<string[]> {
    // Regular files only: a `manual.typ` that is a symbolic link or a submodule is no template.
    const files = await this.repo.git.regularFiles(
      this.commit,
      LAYOUT.templates,
    );
    const ids = new Set<string>();
    for (const path of files.keys()) {
      const m = /^templates\/([^/]+)\/manual\.typ$/.exec(path);
      if (m && DesignTemplateId.safeParse(m[1]).success)
        ids.add(m[1] as string);
    }
    return [...ids].sort();
  }

  /**
   * A page design's own template (#396): the regular files of `templates/<id>/` by their path in
   * it (`manual.typ`, `parts/notice.typ`), or undefined when there is no `manual.typ`. A folder
   * of more than `MAX_TEMPLATE_FILES` files, or more than `MAX_TEMPLATE_BYTES` together, is a
   * `ContentError` (`template-too-large`), told from the listing before anything is read.
   */
  async designTemplate(
    id: string,
  ): Promise<Record<string, Buffer> | undefined> {
    if (!DesignTemplateId.safeParse(id).success) return undefined;
    const dir = designTemplateDir(id);
    const listed = await this.repo.git.regularFiles(this.commit, dir);
    if (!listed.has(designTemplatePath(id))) return undefined;
    let bytes = 0;
    for (const { size } of listed.values()) bytes += size;
    if (listed.size > MAX_TEMPLATE_FILES || bytes > MAX_TEMPLATE_BYTES) {
      throw new ContentError(
        dir,
        `the template holds ${listed.size} files and ${bytes} bytes; at most ${MAX_TEMPLATE_FILES} files and ${MAX_TEMPLATE_BYTES} bytes`,
        'template-too-large',
      );
    }
    const files: Record<string, Buffer> = {};
    await Promise.all(
      [...listed].map(async ([path, { id: blob }]) => {
        const data = await this.repo.git.readBlob(blob);
        if (data) files[path.slice(dir.length + 1)] = data;
      }),
    );
    return files;
  }

  /**
   * The regular files of a page design template's folder (#396), `templates/<id>/`, by their path
   * in it with their size, sorted by path, from the listing alone (nothing is read): what the
   * editor's file list shows. A folder that is not there (or an ID that is no slug) lists none.
   */
  async designTemplateListing(
    id: string,
  ): Promise<{ path: string; size: number }[]> {
    if (!DesignTemplateId.safeParse(id).success) return [];
    const dir = designTemplateDir(id);
    const listed = await this.repo.git.regularFiles(this.commit, dir);
    return [...listed]
      .map(([path, { size }]) => ({ path: path.slice(dir.length + 1), size }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * One regular file of a page design template's folder (#396) by its path in it, or undefined
   * (none, a symbolic link or a submodule, or a path that is no template file's).
   */
  async designTemplateFile(
    id: string,
    path: string,
  ): Promise<Buffer | undefined> {
    if (!DesignTemplateId.safeParse(id).success) return undefined;
    if (!isTemplateFilePath(path)) return undefined;
    const dir = designTemplateDir(id);
    const listed = await this.repo.git.regularFiles(this.commit, dir);
    const found = listed.get(`${dir}/${path}`);
    return found ? this.repo.git.readBlob(found.id) : undefined;
  }

  /**
   * Loads every module a manual needs (following module references) and
   * resolves it. Modules that exist but cannot be read are reported as
   * `invalid-module` issues instead of "missing". `options.visible` leaves
   * out modules the reader may not see (`ResolveInput.visible`); their
   * module references are not followed. `options.manifest` is resolved
   * instead of the stored manifest (e.g. one with only the entries a reader
   * may see); it must be `manualId`'s, read at this commit, and is not read
   * or checked again. `options.standIn` gives a module's text in place of
   * its file (a draft not committed yet); `undefined` from it: the file.
   */
  async resolve(
    manualId: string,
    variant: VariantValues,
    lang: string,
    options: {
      visible?: (module: Module) => boolean;
      manifest?: Manifest;
      standIn?: (id: string, lang: string) => Promise<Module | undefined>;
    } = {},
  ): Promise<ManualResolution | undefined> {
    const { visible, standIn } = options;
    let manifest = options.manifest ?? (await this.manifest(manualId));
    if (!manifest) return undefined;
    // A stored derived manual is gathered here (#451); one given is resolved as it is.
    if (!options.manifest && manifest.kind === 'derived') {
      const derived = await this.derive(manifest);
      manifest = { ...derived.manifest, attributes: derived.attributes };
    }
    const config = await this.config();
    const source = config.languages.source;
    const loaded = new Map<string, Module>();
    const invalid = new Map<string, ContentError>();

    const loadOne = async (
      id: string,
      l: string,
    ): Promise<Module | undefined> => {
      try {
        const module = (await standIn?.(id, l)) ?? (await this.module(id, l));
        if (module) loaded.set(`${l}/${id}`, module);
        return module;
      } catch (e) {
        if (!(e instanceof ContentError)) throw e;
        invalid.set(id, e);
        return undefined;
      }
    };

    const seen = new Set<string>();
    let wave = moduleIds(manifest.entries);
    while (wave.length > 0) {
      wave.forEach((id) => seen.add(id));
      const modules = await Promise.all(
        wave.map(async (id) => {
          const module = await loadOne(id, lang);
          if (module && (!visible || visible(module))) return module;
          // Missing, or not visible: the source version stands in for it.
          const fallback =
            lang === source ? undefined : await loadOne(id, source);
          return fallback ?? module;
        }),
      );
      const next = new Set<string>();
      for (const module of modules) {
        if (!module || (visible && !visible(module))) continue;
        for (const { kind, node } of walk(module.blocks)) {
          if (
            kind === 'block' &&
            node.type === 'moduleRef' &&
            !seen.has(node.module)
          )
            next.add(node.module);
        }
      }
      wave = [...next];
    }

    // The modules a cross-reference links to that the manual does not take in, read for their
    // titles only (#796): a link names its module by title. One that cannot be read keeps its
    // ID, and is no issue of the manual.
    const linkedOnly = new Map<string, Module>();
    const loadLinked = async (
      id: string,
      l: string,
    ): Promise<Module | undefined> => {
      try {
        const module = (await standIn?.(id, l)) ?? (await this.module(id, l));
        if (module) linkedOnly.set(`${l}/${id}`, module);
        return module;
      } catch (e) {
        if (!(e instanceof ContentError)) throw e;
        return undefined;
      }
    };
    const linked = new Set<string>();
    for (const module of loaded.values()) {
      if (visible && !visible(module)) continue;
      for (const id of crossReferencedModules(module.blocks)) {
        if (!seen.has(id)) linked.add(id);
      }
    }
    await Promise.all(
      [...linked].map(async (id) => {
        const module = await loadLinked(id, lang);
        if (lang !== source && !(module && (!visible || visible(module))))
          await loadLinked(id, source);
      }),
    );

    // The terms the modules link (#245), read once each; a term file that
    // cannot be read counts as none (its own checks report it).
    const terms = new Map<string, Term>();
    const termIds = new Set<string>();
    for (const module of loaded.values()) {
      if (visible && !visible(module)) continue;
      for (const id of linkedTermIds(module.blocks)) termIds.add(id);
    }
    await Promise.all(
      [...termIds].map(async (id) => {
        try {
          const term = await this.term(id);
          if (term) terms.set(id, term);
        } catch (e) {
          if (!(e instanceof ContentError)) throw e;
        }
      }),
    );

    const result = resolveManual({
      manifest,
      variant,
      lang,
      config,
      loadModule: (id, l) =>
        loaded.get(`${l}/${id}`) ?? linkedOnly.get(`${l}/${id}`),
      loadTerm: (id) => terms.get(id),
      ...(visible ? { visible } : {}),
    });
    const issues = [
      ...[...invalid].map(([module, error]) => ({
        severity: 'error' as const,
        code: 'invalid-module' as const,
        message: error.message,
        module,
      })),
      ...result.issues.filter(
        (i) =>
          !(
            (i.code === 'missing-module' || i.code === 'missing-translation') &&
            i.module !== undefined &&
            invalid.has(i.module)
          ),
      ),
    ];
    return { ...result, issues, config, manifest };
  }

  /** The file at `path` at this commit, parsed (kept by its blob ID); undefined if there is none. */
  private async parsed<T>(
    path: string,
    parse: (text: string) => T,
  ): Promise<T | undefined> {
    const { git, parsed } = this.repo;
    const known = git.knownFileId(this.commit, path);
    if (known === null) return undefined;
    const cached =
      known === undefined ? undefined : parsed.get(`${known}:${path}`);
    if (cached) return unwrap<T>(cached);
    const entry = await this.repo.shared(`${this.commit}:${path}`, async () => {
      const file = await git.readFileWithId(this.commit, path);
      if (!file) return undefined;
      const key: ParsedKey = `${file.id}:${path}`;
      // Readers of other commits holding the same blob share its parse too.
      return (
        parsed.get(key) ??
        this.repo.shared(
          key,
          async () =>
            parsed.get(key) ??
            parseInto(parsed, key, path, file.content, parse),
        )
      );
    });
    return entry && unwrap<T>(entry);
  }

  /** The blob `id` read as the file at `path`, parsed (kept as `parsed` keeps it); undefined if there is none. */
  private async parsedBlob<T>(
    id: string,
    path: string,
    parse: (text: string) => T,
  ): Promise<T | undefined> {
    const key: ParsedKey = `${id}:${path}`;
    const cached = this.repo.parsed.get(key);
    if (cached) return unwrap<T>(cached);
    const entry = await this.repo.shared(key, async () => {
      const data = await this.repo.git.readBlob(id);
      if (!data) return undefined;
      return (
        this.repo.parsed.get(key) ??
        parseInto(this.repo.parsed, key, path, data, parse)
      );
    });
    return entry && unwrap<T>(entry);
  }
}

function unwrap<T>(entry: Parsed): T {
  if ('error' in entry) throw entry.error;
  return entry.value as T;
}

/**
 * Parses a file's content and keeps the outcome in `cache` under `key`,
 * weighed by the file's size (what it takes in memory grows with it).
 */
function parseInto(
  cache: Lru<Parsed>,
  key: ParsedKey,
  path: string,
  data: Buffer,
  parse: (text: string) => unknown,
): Parsed {
  const weight = data.length + key.length + 256;
  let entry: Parsed;
  try {
    entry = { value: parse(decode(data, path)), weight };
  } catch (e) {
    entry = {
      error:
        e instanceof ContentError
          ? e
          : new ContentError(
              path,
              (e as Error).message,
              e instanceof AsciidocParseError ? e.code : undefined,
            ),
      weight,
    };
  }
  cache.set(key, entry);
  return entry;
}

/** A module file's text, stored as `<lang>/<id>`. */
function parseModuleFile(text: string, id: string, lang: string): Module {
  const module = parseModule(text, { id });
  if (module.meta.lang !== lang) {
    throw new Error(
      `declares language "${module.meta.lang}" but is stored under "${lang}"`,
    );
  }
  return module;
}

function check<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new Error(z.prettifyError(result.error));
  return result.data;
}

function decode(data: Buffer, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new ContentError(path, 'not valid UTF-8');
  }
}

function isModuleId(id: string): boolean {
  return ModuleId.safeParse(id).success;
}

/** Only canonical tags ("pt-BR", not "pt-br"), so every module has exactly one path. */
function isCanonicalLang(lang: string): boolean {
  const result = LanguageTag.safeParse(lang);
  return result.success && result.data === lang;
}

function moduleIds(entries: readonly ManifestEntry[]): string[] {
  return [
    ...new Set(
      entries.flatMap((e) =>
        'entries' in e ? moduleIds(e.entries) : [e.module],
      ),
    ),
  ];
}

function isPageDesignId(id: string): boolean {
  return PageDesignId.safeParse(id).success;
}
