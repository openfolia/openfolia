import { Injectable, Logger } from '@nestjs/common';
import {
  compareWithRecord,
  linkedTermIds,
  sha256Hex,
  sourceHashes,
  textIn,
  walk,
  type Deprecation,
  type ManifestEntry,
  type Module,
  type ProjectConfig,
  type TranslationRecord,
  isConfigFileName,
} from '@openfolia/content-model';
import { InvalidContentError, NotFoundError } from '../../base/core/errors.js';
import { Recent } from '../../base/core/recent.js';
import {
  manifestEntryVariants,
  manifestVariantNames,
  moduleVariantNames,
  type EntryVariants,
  type VariantNames,
} from './variant-names.js';
import {
  ContentRepository,
  type ContentSnapshot,
} from '../../content/core/content.repository.js';
import { DerivedManuals } from '../../content/core/derived-manuals.js';

/**
 * One module file at a commit, as the module index holds it: its metadata
 * (what lists filter and sort by, and what decides who may see it) and the
 * modules it includes. A file that cannot be read has only its `error`.
 */
export interface IndexedModule {
  readonly id: string;
  readonly lang: string;
  readonly meta?: Pick<
    Module['meta'],
    'title' | 'type' | 'audience' | 'facets' | 'keywords' | 'deprecated'
  >;
  /** The module IDs its module reference blocks name, each once, in document order. */
  readonly refs: readonly string[];
  /** The variant attributes and values its variant blocks name; absent when none. */
  readonly variants?: VariantNames;
  /** The term IDs its term links name (#245), each once, in document order; absent when none. */
  readonly terms?: readonly string[];
  /**
   * A digest of the module as parsed (SHA-256 of its JSON): equal digests,
   * equal modules, at any commits, whatever the file's formatting (#480:
   * whether a module differs from the released one). Absent for a file
   * that cannot be read.
   */
  readonly digest?: string;
  /**
   * A source-language file's translatable units, by block ID in document
   * order (`sourceHashes`: what a translation status lists, #480); absent
   * when it has none, and for every other language.
   */
  readonly units?: readonly string[];
  /**
   * A translation (a file in another language than the source) with a
   * translation record that can be read, compared with the source-language
   * file at the same commit (`compareWithRecord`, #480): the source's units
   * the record does not name with their current hash, and the record's
   * source commit. Absent without a record (or one that cannot be read),
   * without a source file that can be read, and for the source language:
   * a translation without it is outdated in every block.
   */
  readonly translation?: IndexedTranslation;
  /** Why the file cannot be read; then there is no `meta`. */
  readonly error?: string;
}

/** A translation compared with its source at the same commit, as the index holds it. */
export interface IndexedTranslation {
  /** The source's units whose translation is outdated, in document order. */
  readonly outdated: readonly string[];
  /** The commit the translation was made from (its record's). */
  readonly sourceCommit: string;
}

/** One manifest at a commit, as the module index holds it. */
export interface IndexedManual {
  readonly id: string;
  readonly title?: string;
  readonly audience?: string;
  /** Withdrawn or superseded (#266); absent when it is not. */
  readonly deprecated?: Deprecation;
  /** The module IDs its entries name (groups flattened), each once, in order. */
  readonly modules: readonly string[];
  /**
   * The variant attributes and values it names that any reader of it may see
   * (its combinations, its text attributes' conditions); absent when none.
   */
  readonly variants?: VariantNames;
  /**
   * Its entries' conditions, each with the modules it covers; absent when
   * none. A reader is told one only where it covers a module they may see
   * (`ReadableModuleIndex`).
   */
  readonly entryVariants?: readonly EntryVariants[];
  /** Why the manifest cannot be read; then it has no title and no modules. */
  readonly error?: string;
}

/**
 * Everything the module index holds about one commit, unfiltered: who may
 * see what is decided when it is read (`ReadableContent.judgeIndexed`),
 * never stored. Derived from Git alone, so it can be dropped and built
 * again with the same result.
 */
export interface CommitIndex {
  readonly commit: string;
  /** By module ID, then language. */
  readonly modules: readonly IndexedModule[];
  /** By manual ID. */
  readonly manuals: readonly IndexedManual[];
}

/**
 * What building an index reads of a commit. `isDerived` says whether a manual is a derived one
 * (#451, `DerivedManuals`), whose entries depend on other files than its own, so it is never
 * carried over; none: no manual is.
 */
export type IndexSource = Pick<
  ContentSnapshot,
  | 'commit'
  | 'config'
  | 'modules'
  | 'module'
  | 'translationRecord'
  | 'manifests'
  | 'manifest'
> & { isDerived?(id: string): Promise<boolean> };

/**
 * Port: where commit indexes are kept (the `module_index_*` tables), so a
 * restart or another server does not parse every file again. Rebuildable:
 * Git stays the source of truth.
 */
export abstract class ModuleIndexStore {
  /** The commit's index, or undefined when it has not been built. */
  abstract get(commit: string): Promise<CommitIndex | undefined>;
  /**
   * Keeps `index`, unless the commit's is already kept (another server
   * built it meanwhile: the same, as both come from the same commit), and
   * drops the oldest beyond the newest `keep` commits.
   */
  abstract put(index: CommitIndex, keep: number): Promise<void>;
  /** Drops every kept index (the full rebuild starts with this). */
  abstract clear(): Promise<void>;
}

/** How many commits' indexes the store keeps; older ones are built again when asked for. */
export const INDEXED_COMMITS_KEPT = 64;

/**
 * What a commit's index holds, counted: raised whenever what is derived from
 * the files changes (a new column, another digest), so an index written
 * before is built again rather than read or carried over to other commits.
 * 1: digests, units and translations (#480).
 */
export const INDEX_FORMAT = 1;
/** How many commits' indexes a server keeps in memory. */
export const INDEXES_IN_MEMORY = 16;

/**
 * The module index (#45): per commit, the modules with the metadata lists
 * filter and sort by, the manuals, and what includes what, built from Git
 * when a commit is first read (so every change, a save point, a merge, a
 * push, is indexed on the next read of it) and kept in `ModuleIndexStore`
 * and in memory. A commit never changes, so neither does its index.
 */
@Injectable()
export class ModuleIndex {
  readonly #recent = new Recent<CommitIndex>(INDEXES_IN_MEMORY);
  readonly #logger = new Logger('ModuleIndex');
  /** The index this server built or read last: what the next one is carried over from. */
  #last: CommitIndex | undefined;

  constructor(
    private readonly store: ModuleIndexStore,
    private readonly content: ContentRepository,
  ) {}

  /** The index of `commit` (a full commit ID), built and kept when there is none. */
  at(commit: string): Promise<CommitIndex> {
    return this.#recent.get(commit, async () => {
      // The store only saves work: when it fails, the index is built from Git.
      const kept = await this.store.get(commit).catch((error: unknown) => {
        this.#logger.warn(`Reading the index of ${commit}: ${reason(error)}`);
        return undefined;
      });
      if (kept) return (this.#last = kept);
      const snapshot = await this.content.at(commit);
      if (snapshot?.commit !== commit) {
        throw new NotFoundError(`No commit "${commit}".`);
      }
      const built = await this.#build(snapshot, this.#last);
      await this.store
        .put(built, INDEXED_COMMITS_KEPT)
        .catch((error: unknown) => {
          this.#logger.warn(`Keeping the index of ${commit}: ${reason(error)}`);
        });
      return (this.#last = built);
    });
  }

  /**
   * The full rebuild: drops every kept index, then indexes the commit of
   * every branch and tag again (each from the one before, `#build`).
   * Returns the commits indexed.
   */
  async rebuild(): Promise<string[]> {
    await this.store.clear();
    const { branches, tags } = await this.content.refs();
    const commits = [
      ...new Set([...branches, ...tags].map((ref) => ref.commit)),
    ].slice(0, INDEXED_COMMITS_KEPT);
    let last: CommitIndex | undefined;
    for (const commit of commits) {
      const snapshot = await this.content.at(commit);
      if (snapshot?.commit !== commit) continue;
      last = await this.#build(snapshot, last);
      await this.store.put(last, commits.length);
    }
    return commits;
  }

  /**
   * The index of `snapshot`: carried over from `base` (another commit's,
   * the last one this server built or read) where the repository names
   * the paths that differ (`updateCommitIndex`), so a save point costs
   * what it changed (#480); else built from every file.
   */
  async #build(
    files: ContentSnapshot,
    base: CommitIndex | undefined,
  ): Promise<CommitIndex> {
    // Derived manuals with their entries gathered (#451), as every reader reads them.
    const snapshot = DerivedManuals.of(files);
    if (base && base.commit !== snapshot.commit) {
      const changed = await this.content
        .differingPaths(base.commit, snapshot.commit)
        .catch((error: unknown) => {
          this.#logger.warn(
            `Comparing ${base.commit} with ${snapshot.commit}: ${reason(error)}`,
          );
          return undefined;
        });
      if (changed) return updateCommitIndex(snapshot, base, changed);
    }
    return buildCommitIndex(snapshot);
  }
}

/**
 * The index of one commit, read from Git: every module file (a broken one
 * with its error) and every manifest. Deterministic: the same commit gives
 * the same index.
 */
export function buildCommitIndex(source: IndexSource): Promise<CommitIndex> {
  return indexOf(source, undefined);
}

/**
 * The index of `source`'s commit from `base`, another commit's, and the
 * repository paths that differ between the two (`changed`): what a file
 * unchanged holds is taken from `base`, and only the files changed are
 * read (a translation again when its source file or its record changed).
 * The same index `buildCommitIndex` gives; built from every file when the
 * configuration changed (it says which language is the source).
 */
export function updateCommitIndex(
  source: IndexSource,
  base: CommitIndex,
  changed: readonly string[],
): Promise<CommitIndex> {
  return indexOf(
    source,
    changed.some(isConfigFileName) ? undefined : { base, changed },
  );
}

/** What a commit's index is carried over from. */
interface CarriedFrom {
  readonly base: CommitIndex;
  readonly changed: readonly string[];
}

/** What of `from.base` holds at the new commit: its files and manifests that did not change. */
function carriedOver(from: CarriedFrom, sourceLang: string | undefined) {
  const files = new Set<string>();
  const ids = new Set<string>();
  const manuals = new Set<string>();
  for (const path of from.changed) {
    const file = /^modules\/([^/]+)\/([^/]+)\.(adoc|translation\.yaml)$/.exec(
      path,
    );
    if (file) {
      const [, lang = '', id = '', kind] = file;
      files.add(`${lang}/${id}`);
      // Its translations are compared with it.
      if (kind === 'adoc' && lang === sourceLang) ids.add(id);
      continue;
    }
    const manual = /^manuals\/([^/]+)\.yaml$/.exec(path);
    if (manual) manuals.add(manual[1] as string);
  }
  const modules = new Map(
    from.base.modules
      .filter((m) => !files.has(`${m.lang}/${m.id}`) && !ids.has(m.id))
      .map((m) => [`${m.lang}/${m.id}`, m]),
  );
  const kept = new Map(
    from.base.manuals.filter((m) => !manuals.has(m.id)).map((m) => [m.id, m]),
  );
  return {
    module: (id: string, lang: string) => modules.get(`${lang}/${id}`),
    manual: (id: string) => kept.get(id),
  };
}

async function indexOf(
  source: IndexSource,
  from: CarriedFrom | undefined,
): Promise<CommitIndex> {
  const [files, manualIds, sourceLang] = await Promise.all([
    source.modules(),
    source.manifests(),
    sourceLanguage(source),
  ]);
  const carried = from && carriedOver(from, sourceLang);
  // By module ID, so each source file is read once for its translations and let go after.
  const byId = new Map<string, string[]>();
  for (const { id, lang } of files) {
    const langs = byId.get(id);
    if (langs) langs.push(lang);
    else byId.set(id, [lang]);
  }
  const modules = (
    await Promise.all(
      [...byId].map(async ([id, langs]) => {
        let original: Promise<ReadModule | undefined> | undefined;
        const readSource = () =>
          (original ??=
            sourceLang !== undefined && langs.includes(sourceLang)
              ? readModule(source, id, sourceLang)
              : Promise.resolve(undefined));
        return Promise.all(
          langs.map(async (lang) => {
            const kept = carried?.module(id, lang);
            if (kept) return kept;
            const isSource = lang === sourceLang;
            const read = isSource
              ? await readSource()
              : await readModule(source, id, lang);
            const translation =
              isSource || !read || 'error' in read
                ? undefined
                : await translationOf(source, id, lang, await readSource());
            return indexedModule(id, lang, read, isSource, translation);
          }),
        );
      }),
    )
  ).flat();
  const manuals = await Promise.all(
    manualIds.map(async (id): Promise<IndexedManual> => {
      const kept = carried?.manual(id);
      // A derived manual's entries are gathered from other files (#451): read again.
      if (kept && !(await source.isDerived?.(id))) return kept;
      return indexedManual(source, id, sourceLang);
    }),
  );
  return {
    commit: source.commit,
    modules: modules.sort(
      (a, b) => compare(a.id, b.id) || compare(a.lang, b.lang),
    ),
    manuals: manuals.sort((a, b) => compare(a.id, b.id)),
  };
}

/** One manifest as the index holds it. */
async function indexedManual(
  source: IndexSource,
  id: string,
  sourceLang: string | undefined,
): Promise<IndexedManual> {
  try {
    const manifest = await source.manifest(id);
    if (!manifest) {
      return { id, modules: [], error: 'The manifest file is gone.' };
    }
    const variants = manifestVariantNames(manifest);
    const entryVariants = manifestEntryVariants(manifest);
    return {
      id,
      // As a listing without a language names it (#731): in the source language.
      title: textIn(manifest.title, sourceLang ?? '', sourceLang ?? ''),
      ...(manifest.audience !== undefined && {
        audience: manifest.audience,
      }),
      ...(manifest.deprecated && { deprecated: manifest.deprecated }),
      modules: [...new Set(entryModules(manifest.entries))],
      ...(Object.keys(variants).length > 0 && { variants }),
      ...(entryVariants.length > 0 && { entryVariants }),
    };
  } catch (error) {
    if (!(error instanceof InvalidContentError)) throw error;
    return { id, modules: [], error: error.message };
  }
}

type ReadModule = { readonly module: Module } | { readonly error: string };

/** One module file as the index holds it. */
function indexedModule(
  id: string,
  lang: string,
  read: ReadModule | undefined,
  isSource: boolean,
  translation: IndexedTranslation | undefined,
): IndexedModule {
  if (!read || 'error' in read) {
    return {
      id,
      lang,
      refs: [],
      error: read?.error ?? 'The module file is gone.',
    };
  }
  const { module } = read;
  const { title, type, audience, facets, keywords, deprecated } = module.meta;
  const variants = moduleVariantNames(module);
  const terms = linkedTermIds(module.blocks);
  const units = isSource ? [...sourceHashes(module).keys()] : [];
  return {
    id,
    lang,
    meta: {
      title,
      type,
      ...(audience !== undefined && { audience }),
      facets,
      ...(keywords?.length && { keywords }),
      ...(deprecated && { deprecated }),
    },
    refs: moduleRefs(module),
    ...(Object.keys(variants).length > 0 && { variants }),
    ...(terms.length > 0 && { terms }),
    digest: sha256Hex(JSON.stringify(module)),
    ...(units.length > 0 && { units }),
    ...(translation && { translation }),
  };
}

/** A module file parsed, or why it cannot be; undefined when it is gone. */
async function readModule(
  source: IndexSource,
  id: string,
  lang: string,
): Promise<ReadModule | undefined> {
  try {
    const module = await source.module(id, lang);
    return module && { module };
  } catch (error) {
    if (!(error instanceof InvalidContentError)) throw error;
    return { error: error.message };
  }
}

/**
 * The source language, or undefined when the configuration cannot be read
 * (every read of the commit fails then, so no translation status is told).
 */
async function sourceLanguage(
  source: IndexSource,
): Promise<string | undefined> {
  let config: ProjectConfig;
  try {
    config = await source.config();
  } catch (error) {
    if (!(error instanceof InvalidContentError)) throw error;
    return undefined;
  }
  return config.languages.source;
}

/**
 * A translation's record compared with the source-language file, both at
 * this commit: undefined without a record (or one that cannot be read) or
 * without a source file that can be read.
 */
async function translationOf(
  source: IndexSource,
  id: string,
  lang: string,
  original: ReadModule | undefined,
): Promise<IndexedTranslation | undefined> {
  if (!original || 'error' in original) return undefined;
  let record: TranslationRecord | undefined;
  try {
    record = await source.translationRecord(id, lang);
  } catch (error) {
    if (!(error instanceof InvalidContentError)) throw error;
    return undefined;
  }
  if (!record) return undefined;
  return {
    outdated: compareWithRecord(original.module, record)
      .filter((b) => b.state === 'outdated')
      .map((b) => b.blockId),
    sourceCommit: record.sourceCommit,
  };
}

/** The modules a module's reference blocks name, each once, in document order. */
function moduleRefs(module: Module): string[] {
  const refs = new Set<string>();
  for (const { kind, node } of walk(module.blocks)) {
    if (kind === 'block' && node.type === 'moduleRef') refs.add(node.module);
  }
  return [...refs];
}

function* entryModules(entries: readonly ManifestEntry[]): Generator<string> {
  for (const entry of entries) {
    if ('module' in entry) yield entry.module;
    else yield* entryModules(entry.entries);
  }
}

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Code-unit order: the same on every server, whatever its locale. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
