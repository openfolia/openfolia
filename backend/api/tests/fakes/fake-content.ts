import { createHash } from 'node:crypto';
import {
  isTermId,
  parseTerm,
  printConfig,
  printManifest,
  printModule,
  printTranslationRecord,
  ProjectConfig,
  resolveManual,
  walk,
  type Manifest,
  type Module,
  type TranslationRecord,
  type VariantValues,
  type Term,
  TermParseError,
  PageDesignId,
  PageDesignParseError,
  parsePageDesign,
  type PageDesign,
} from '@openfolia/content-model';
import type { Actor } from '../../src/access/core/actor.js';
import { InvalidContentError } from '../../src/base/core/errors.js';
import type {
  ContentSnapshot,
  DeletedManifestFiles,
  DeletedModuleFiles,
  ManualResolution,
  ModuleFile,
  ModuleFileHistory,
  ModuleFileVersion,
  ModuleStandIn,
} from '../../src/content/core/content.repository.js';
import {
  ReadableContent,
  type ReadPermission,
} from '../../src/content/core/readable-content.js';
import { READER } from './actors.js';

/** In-memory content for unit tests of the core; no Git involved. */
export interface FakeContent {
  /** The configuration's file under its earlier name, `ccms.yaml`, alone (#372). */
  legacyConfigFile?: boolean;
  config?: ProjectConfig;
  modules?: Module[];
  /** Module files that exist but cannot be parsed. */
  brokenModules?: ModuleFile[];
  manifests?: Manifest[];
  /** Manifest IDs whose files cannot be parsed. */
  brokenManifests?: string[];
  /** Translation records by `lang/id` of the translated module. */
  translationRecords?: Record<string, TranslationRecord>;
  /** `lang/id`s whose translation record cannot be parsed. */
  brokenTranslationRecords?: string[];
  assets?: Record<string, Uint8Array>;
  /** This commit as a version in a history (`moduleHistory`). */
  commitInfo?: Partial<
    Pick<ModuleFileVersion, 'message' | 'trailers' | 'parents' | 'committedAt'>
  >;
  /** The first-parent line before this commit, newest first. */
  line?: readonly FakeSnapshot[];
  /** Term files (`terms/<id>.yaml`) by ID, as text. */
  terms?: Record<string, string>;
  /** Page design files (`design/<id>.yaml`, #390) by ID, as text. */
  pageDesigns?: Record<string, string>;
  /**
   * Page design templates (`templates/<id>/`, #396) by ID: each its files by path in the folder,
   * as text or bytes.
   */
  designTemplates?: Record<string, Record<string, string | Uint8Array>>;
  /** Safety symbols' artwork by repository path (`symbols/<id>.svg` or `.png`). */
  symbols?: Record<string, Uint8Array>;
}

export const config: ProjectConfig = ProjectConfig.parse({
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [{ id: 'concept', label: 'Concept' }],
  audiences: [{ id: 'public', label: 'Public' }],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large' },
      ],
    },
  ],
  textAttributes: [],
  safetySymbols: [],
});

export function module(id: string, lang = 'en', text = 'Hello.'): Module {
  return {
    schemaVersion: 1,
    id,
    meta: {
      title: `Title of ${id}`,
      type: 'concept',
      lang,
      audience: 'public',
      facets: {},
    },
    blocks: [{ type: 'paragraph', id: 'p', content: [{ type: 'text', text }] }],
  };
}

export function manifest(id: string, modules: string[]): Manifest {
  return {
    schemaVersion: 1,
    id,
    title: `Manual ${id}`,
    audience: 'public',
    variants: [{ model: 'small' }, { model: 'large' }],
    attributes: {},
    entries: modules.map((m) => ({ module: m })),
  } as Manifest;
}

/**
 * The stand-ins for every module the manifest, the files and the stand-ins
 * themselves name (module references followed), in `langs`, by `lang/id`.
 */
async function standIns(
  manifest: Manifest,
  modules: readonly Module[],
  langs: readonly string[],
  standIn: ModuleStandIn,
): Promise<Map<string, Module>> {
  const named = (entries: Manifest['entries']): string[] =>
    entries.flatMap((e) => ('module' in e ? [e.module] : named(e.entries)));
  const found = new Map<string, Module>();
  const seen = new Set<string>();
  let wave = [...named(manifest.entries), ...modules.map((m) => m.id)];
  while (wave.length > 0) {
    const next: string[] = [];
    for (const id of wave) {
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of new Set(langs)) {
        const module = await standIn(id, l);
        if (!module) continue;
        found.set(`${l}/${id}`, module);
        for (const { kind, node } of walk(module.blocks)) {
          if (kind === 'block' && node.type === 'moduleRef') {
            next.push(node.module);
          }
        }
      }
    }
    wave = next;
  }
  return found;
}

const brokenError = (path: string) =>
  new InvalidContentError(path, `${path}: not a module`);

let fakeCommits = 1;

/** Every fake snapshot made in this test process, by commit: what a fake repository finds. */
const fakeSnapshots = new Map<string, FakeSnapshot>();

/** The fake snapshot made with `commit` (the last one, if several were), or undefined. */
export const fakeSnapshotAt = (commit: string): FakeSnapshot | undefined =>
  fakeSnapshots.get(commit);

/**
 * The paths whose files differ between two fake snapshots (by commit), as
 * `ContentRepository.changedPaths` gives them; undefined for a commit no
 * fake snapshot has.
 */
export async function fakeChangedPaths(
  from: string,
  to: string,
): Promise<string[] | undefined> {
  const [a, b] = [fakeSnapshotAt(from), fakeSnapshotAt(to)];
  if (!a || !b) return undefined;
  const changed: string[] = [];
  for (const path of new Set([...a.paths(), ...b.paths()])) {
    const [x, y] = await Promise.all([a.file(path), b.file(path)]);
    if (!x || !y || Buffer.compare(Buffer.from(x), Buffer.from(y)) !== 0) {
      changed.push(path);
    }
  }
  return changed.sort();
}

/** A new commit ID, unique in the test process. */
export const fakeCommitId = (): string =>
  (fakeCommits++).toString(16).padStart(40, 'c');

export class FakeSnapshot implements ContentSnapshot {
  /** Unique per snapshot, as different content has different commits. */
  readonly commit: string;

  constructor(
    readonly content: FakeContent = {},
    commit: string = fakeCommitId(),
  ) {
    this.commit = commit;
    fakeSnapshots.set(commit, this);
  }

  config() {
    return Promise.resolve(this.content.config ?? config);
  }

  modules(lang?: string): Promise<ModuleFile[]> {
    const files = [
      ...(this.content.modules ?? []).map((m) => ({
        id: m.id,
        lang: m.meta.lang,
      })),
      ...(this.content.brokenModules ?? []),
    ]
      .filter((f) => lang === undefined || f.lang === lang)
      .sort((a, b) => `${a.lang}/${a.id}`.localeCompare(`${b.lang}/${b.id}`));
    return Promise.resolve(files);
  }

  module(id: string, lang: string): Promise<Module | undefined> {
    if (
      this.content.brokenModules?.some((f) => f.id === id && f.lang === lang)
    ) {
      return Promise.reject(brokenError(`modules/${lang}/${id}.adoc`));
    }
    return Promise.resolve(
      this.content.modules?.find((m) => m.id === id && m.meta.lang === lang),
    );
  }

  /** A hash of the file `file` gives: equal files, equal revisions. */
  async moduleRevision(id: string, lang: string): Promise<string | undefined> {
    const bytes = await this.file(`modules/${lang}/${id}.adoc`);
    return bytes && createHash('sha1').update(bytes).digest('hex');
  }

  /** Over `content.line`: the commits whose revision differs from the next older one's. */
  moduleHistory(
    id: string,
    lang: string,
    max: number,
  ): Promise<ModuleFileHistory> {
    return this.#history((s) => s.moduleRevision(id, lang), max);
  }

  /** A hash of the manifest's file `file` gives: equal files, equal revisions. */
  async manifestRevision(id: string): Promise<string | undefined> {
    const bytes = await this.file(`manuals/${id}.yaml`);
    return bytes && createHash('sha1').update(bytes).digest('hex');
  }

  /** Over `content.line`, as `moduleHistory`. */
  manifestHistory(id: string, max: number): Promise<ModuleFileHistory> {
    return this.#history((s) => s.manifestRevision(id), max);
  }

  async #history(
    revisionOf: (s: FakeSnapshot) => Promise<string | undefined>,
    max: number,
  ): Promise<ModuleFileHistory> {
    const all = [this, ...(this.content.line ?? [])];
    const revisions = await Promise.all(all.map(revisionOf));
    const versions = all.slice(0, max).flatMap((s, i): ModuleFileVersion[] => {
      const revision = revisions[i];
      if (revision === revisions[i + 1]) return [];
      const info = s.content.commitInfo ?? {};
      return [
        {
          commit: s.commit,
          parents: info.parents ?? 1,
          committedAt: info.committedAt ?? '2026-01-01T00:00:00Z',
          message: info.message ?? '',
          trailers: info.trailers ?? [],
          ...(revision !== undefined && { revision }),
        },
      ];
    });
    const truncated = all.length > max;
    const before = truncated ? revisions[max] : undefined;
    return { versions, truncated, ...(before !== undefined && { before }) };
  }

  /**
   * Over `content.line`: the module files an older snapshot among the newest `max` has and
   * this one has not, each with the commit after its newest snapshot with it.
   */
  async deletedModules(max: number): Promise<DeletedModuleFiles> {
    const { files, truncated } = await this.#deleted(
      async (s) =>
        (await s.modules()).map((f) => ({
          key: `${f.lang}/${f.id}`,
          file: f,
          revision: () => s.moduleRevision(f.id, f.lang),
        })),
      max,
    );
    return {
      files: files.map(({ file, ...rest }) => ({ ...file, ...rest })),
      truncated,
    };
  }

  /** Over `content.line`, as `deletedModules`. */
  async deletedManifests(max: number): Promise<DeletedManifestFiles> {
    const { files, truncated } = await this.#deleted(
      async (s) =>
        (await s.manifests()).map((id) => ({
          key: id,
          file: { id },
          revision: () => s.manifestRevision(id),
        })),
      max,
    );
    return {
      files: files.map(({ file, ...rest }) => ({ ...file, ...rest })),
      truncated,
    };
  }

  async #deleted<F>(
    filesOf: (s: FakeSnapshot) => Promise<
      {
        key: string;
        file: F;
        revision: () => Promise<string | undefined>;
      }[]
    >,
    max: number,
  ): Promise<{
    files: { file: F; revision: string; commit: string; committedAt: string }[];
    truncated: boolean;
  }> {
    const all = [this, ...(this.content.line ?? [])];
    const here = new Set((await filesOf(this)).map((f) => f.key));
    const files: {
      file: F;
      revision: string;
      commit: string;
      committedAt: string;
    }[] = [];
    const listed = new Set<string>();
    for (let i = 1; i <= Math.min(max, all.length - 1); i++) {
      const older = all[i] as FakeSnapshot;
      const deleter = all[i - 1] as FakeSnapshot;
      const after = new Set((await filesOf(deleter)).map((f) => f.key));
      for (const { key, file, revision } of await filesOf(older)) {
        if (here.has(key) || listed.has(key) || after.has(key)) continue;
        listed.add(key);
        files.push({
          file,
          revision: (await revision()) as string,
          commit: deleter.commit,
          committedAt:
            deleter.content.commitInfo?.committedAt ?? '2026-01-01T00:00:00Z',
        });
      }
    }
    return { files, truncated: all.length > max };
  }

  /** The module of the first snapshot on the line holding that revision. */
  async moduleAtRevision(
    id: string,
    lang: string,
    revision: string,
  ): Promise<Module | undefined> {
    for (const s of [this, ...(this.content.line ?? [])]) {
      if ((await s.moduleRevision(id, lang)) === revision) {
        return s.module(id, lang);
      }
    }
    return undefined;
  }

  /** The manifest of the first snapshot on the line holding that revision. */
  async manifestAtRevision(
    id: string,
    revision: string,
  ): Promise<Manifest | undefined> {
    for (const s of [this, ...(this.content.line ?? [])]) {
      if ((await s.manifestRevision(id)) === revision) return s.manifest(id);
    }
    return undefined;
  }

  terms(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.content.terms ?? {}).sort());
  }

  term(id: string): Promise<Term | undefined> {
    const text = Object.entries(this.content.terms ?? {}).find(
      ([termId]) => termId === id,
    )?.[1];
    if (text === undefined || !isTermId(id)) return Promise.resolve(undefined);
    try {
      return Promise.resolve(parseTerm(text, { id }));
    } catch (error) {
      if (!(error instanceof TermParseError)) throw error;
      return Promise.reject(
        new InvalidContentError(
          `terms/${id}.yaml`,
          `terms/${id}.yaml: ${error.message}`,
        ),
      );
    }
  }

  pageDesigns(): Promise<string[]> {
    return Promise.resolve(Object.keys(this.content.pageDesigns ?? {}).sort());
  }

  pageDesign(id: string): Promise<PageDesign | undefined> {
    const designs = new Map(Object.entries(this.content.pageDesigns ?? {}));
    const text = designs.get(id);
    if (text === undefined || !PageDesignId.safeParse(id).success)
      return Promise.resolve(undefined);
    try {
      return Promise.resolve(parsePageDesign(text, { id }));
    } catch (error) {
      if (!(error instanceof PageDesignParseError)) throw error;
      return Promise.reject(
        new InvalidContentError(
          `design/${id}.yaml`,
          `design/${id}.yaml: ${error.message}`,
        ),
      );
    }
  }

  translationRecord(
    id: string,
    lang: string,
  ): Promise<TranslationRecord | undefined> {
    const key = `${lang}/${id}`;
    if (this.content.brokenTranslationRecords?.includes(key)) {
      return Promise.reject(
        new InvalidContentError(
          `modules/${key}.translation.yaml`,
          `modules/${key}.translation.yaml: not a record`,
        ),
      );
    }
    const records = this.content.translationRecords ?? {};
    return Promise.resolve(
      Object.hasOwn(records, key) ? records[key] : undefined,
    );
  }

  manifests(): Promise<string[]> {
    return Promise.resolve(
      [
        ...(this.content.manifests ?? []).map((m) => m.id),
        ...(this.content.brokenManifests ?? []),
      ].sort(),
    );
  }

  manifest(id: string): Promise<Manifest | undefined> {
    if (this.content.brokenManifests?.includes(id)) {
      return Promise.reject(brokenError(`manuals/${id}.yaml`));
    }
    return Promise.resolve(this.content.manifests?.find((m) => m.id === id));
  }

  async resolve(
    manifest: Manifest,
    variant: VariantValues,
    lang: string,
    visible: (module: Module) => boolean = () => true,
    standIn?: ModuleStandIn,
  ): Promise<ManualResolution | undefined> {
    const config = await this.config();
    const modules = this.content.modules ?? [];
    const stood = standIn
      ? await standIns(
          manifest,
          modules,
          [lang, config.languages.source],
          standIn,
        )
      : new Map<string, Module>();
    const termsById = new Map<string, Term>();
    for (const id of Object.keys(this.content.terms ?? {})) {
      const term = await this.term(id).catch(() => undefined);
      if (term) termsById.set(id, term);
    }
    const result = resolveManual({
      manifest,
      variant,
      lang,
      config,
      loadModule: (id, l) =>
        stood.get(`${l}/${id}`) ??
        modules.find((m) => m.id === id && m.meta.lang === l),
      visible,
      // As the Git snapshot does: a term that cannot be read is none.
      loadTerm: (id) => termsById.get(id),
    });
    // As the Git snapshot does: a broken file is invalid, not missing.
    const broken = new Set(
      (this.content.brokenModules ?? [])
        .filter((f) => f.lang === lang || f.lang === config.languages.source)
        .map((f) => f.id),
    );
    const issues = result.issues.flatMap((issue) =>
      issue.module !== undefined &&
      broken.has(issue.module) &&
      (issue.code === 'missing-module' || issue.code === 'missing-translation')
        ? [
            {
              severity: 'error' as const,
              code: 'invalid-module' as const,
              message: `modules/${lang}/${issue.module}.adoc: not a module`,
              module: issue.module,
            },
          ]
        : [issue],
    );
    return { ...result, issues, manifest, config };
  }

  asset(hash: string) {
    return Promise.resolve(this.content.assets?.[hash]);
  }

  hasAsset(hash: string) {
    return Promise.resolve(this.content.assets?.[hash] !== undefined);
  }

  /** As the repository lists them: `symbols/<id>.svg|png`, the first of an ID by path. */
  symbols() {
    const found = new Map<string, string>();
    for (const path of Object.keys(this.content.symbols ?? {}).sort()) {
      const m = /^symbols\/([a-z0-9-]+)\.(svg|png)$/.exec(path);
      if (m && !found.has(m[1] as string)) found.set(m[1] as string, path);
    }
    return Promise.resolve(found);
  }

  /** The paths of its modules, translation records, manifests, configuration and terms. */
  paths(): string[] {
    const c = this.content;
    return [
      c.legacyConfigFile === true ? 'ccms.yaml' : 'openfolia.yaml',
      ...(c.modules ?? []).map((m) => `modules/${m.meta.lang}/${m.id}.adoc`),
      ...(c.brokenModules ?? []).map((f) => `modules/${f.lang}/${f.id}.adoc`),
      ...[
        ...Object.keys(c.translationRecords ?? {}),
        ...(c.brokenTranslationRecords ?? []),
      ].map((key) => `modules/${key}.translation.yaml`),
      ...(c.manifests ?? []).map((m) => `manuals/${m.id}.yaml`),
      ...(c.brokenManifests ?? []).map((id) => `manuals/${id}.yaml`),
      ...Object.keys(c.terms ?? {}).map((id) => `terms/${id}.yaml`),
      ...Object.keys(c.pageDesigns ?? {}).map((id) => `design/${id}.yaml`),
      ...Object.entries(c.designTemplates ?? {}).flatMap(([id, files]) =>
        Object.keys(files).map((path) => `templates/${id}/${path}`),
      ),
      ...Object.keys(c.symbols ?? {}),
    ];
  }

  /**
   * A module's, manifest's or the configuration's file as the printer
   * writes it (a broken one as text that is none), or a term's text;
   * undefined for anything else, unless a test replaces it.
   */
  file: (path: string) => Promise<Uint8Array | undefined> = (path) => {
    const encode = (text: string) =>
      Promise.resolve(new TextEncoder().encode(text));
    const record = /^modules\/([^/]+\/[^/]+)\.translation\.yaml$/.exec(path);
    if (record) {
      const key = record[1] as string;
      if (this.content.brokenTranslationRecords?.includes(key)) {
        return encode('not a record');
      }
      const records = this.content.translationRecords ?? {};
      const found = Object.hasOwn(records, key) ? records[key] : undefined;
      return found
        ? encode(printTranslationRecord(found))
        : Promise.resolve(undefined);
    }
    const module = /^modules\/([^/]+)\/([^/]+)\.adoc$/.exec(path);
    if (module) {
      const [, lang, id] = module;
      if (
        this.content.brokenModules?.some((f) => f.id === id && f.lang === lang)
      ) {
        return encode('not a module');
      }
      const found = this.content.modules?.find(
        (m) => m.id === id && m.meta.lang === lang,
      );
      return found ? encode(printModule(found)) : Promise.resolve(undefined);
    }
    const manual = /^manuals\/([^/]+)\.yaml$/.exec(path);
    if (manual) {
      if (this.content.brokenManifests?.includes(manual[1] ?? '')) {
        return encode('not a manifest');
      }
      const found = this.content.manifests?.find((m) => m.id === manual[1]);
      return found ? encode(printManifest(found)) : Promise.resolve(undefined);
    }
    if (
      path ===
      (this.content.legacyConfigFile === true ? 'ccms.yaml' : 'openfolia.yaml')
    ) {
      return encode(printConfig(this.content.config ?? config));
    }
    const symbols = new Map(Object.entries(this.content.symbols ?? {}));
    if (symbols.has(path)) return Promise.resolve(symbols.get(path));
    const inTemplate = /^templates\/([^/]+)\/(.+)$/.exec(path);
    if (inTemplate) {
      const files = this.content.designTemplates?.[inTemplate[1] ?? ''];
      const data =
        files && Object.hasOwn(files, inTemplate[2] ?? '')
          ? files[inTemplate[2] ?? '']
          : undefined;
      return data === undefined
        ? Promise.resolve(undefined)
        : typeof data === 'string'
          ? encode(data)
          : Promise.resolve(data);
    }
    const term = /^terms\/([^/]+)\.yaml$/.exec(path);
    const terms = new Map(Object.entries(this.content.terms ?? {}));
    const design = /^design\/([^/]+)\.yaml$/.exec(path);
    const designs = new Map(Object.entries(this.content.pageDesigns ?? {}));
    const text = term
      ? terms.get(term[1] ?? '')
      : design
        ? designs.get(design[1] ?? '')
        : undefined;
    return text === undefined ? Promise.resolve(undefined) : encode(text);
  };

  template() {
    return Promise.resolve(undefined);
  }

  /** `designTemplates` by ID (#396): each a folder's files by path, text or bytes. */
  designTemplate(id: string): Promise<Record<string, Uint8Array> | undefined> {
    const files = this.content.designTemplates?.[id];
    if (!files || !('manual.typ' in files)) return Promise.resolve(undefined);
    return Promise.resolve(
      Object.fromEntries(
        Object.entries(files).map(([path, data]) => [
          path,
          typeof data === 'string' ? new TextEncoder().encode(data) : data,
        ]),
      ),
    );
  }

  designTemplateIds() {
    return Promise.resolve(
      Object.entries(this.content.designTemplates ?? {})
        .filter(([, files]) => 'manual.typ' in files)
        .map(([id]) => id)
        .sort(),
    );
  }

  /** `designTemplates[id]`'s files by path, sorted (#396). */
  designTemplateListing(id: string) {
    const files = this.content.designTemplates?.[id] ?? {};
    return Promise.resolve(
      Object.entries(files)
        .map(([path, data]) => ({
          path,
          size:
            typeof data === 'string'
              ? new TextEncoder().encode(data).length
              : data.length,
          draft: false,
          committed: true,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    );
  }

  designTemplateFile(id: string, path: string) {
    const files = this.content.designTemplates?.[id];
    const data = files && Object.hasOwn(files, path) ? files[path] : undefined;
    return Promise.resolve(
      typeof data === 'string' ? new TextEncoder().encode(data) : data,
    );
  }

  designTemplateRevision() {
    return Promise.resolve('');
  }

  /** A fixed time: 2024-01-01T00:00:00Z. */
  committedAt() {
    return Promise.resolve(1_704_067_200);
  }
}

/**
 * Content as `actor` may read it (`READER`, everything, by default), as
 * `OpenSnapshotAction` would open it: from `FakeContent` or a snapshot.
 */
export function readable(
  content: FakeContent | ContentSnapshot = {},
  actor: Actor = READER,
  permission: ReadPermission = 'content.read',
): ReadableContent {
  const snapshot =
    content instanceof FakeSnapshot || 'commit' in content
      ? (content as ContentSnapshot)
      : new FakeSnapshot(content);
  return new ReadableContent(snapshot, actor, permission);
}
