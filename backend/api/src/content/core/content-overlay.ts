import { createHash } from 'node:crypto';
import {
  DESIGN_TEMPLATE_ENTRY,
  type Manifest,
  type Module,
  type PageDesign,
  type VariantValues,
} from '@openfolia/content-model';
import type {
  ContentSnapshot,
  ManualResolution,
  ModuleFile,
  ModuleStandIn,
  TemplateFileEntry,
} from './content.repository.js';
import {
  pastTemplateCaps,
  refusePastTemplateCaps,
  templateFolderSize,
} from './template-caps.js';

/**
 * How many of a template's committed files the overlay reads at once (#803): a folder within the
 * caps is read a few files at a time, never all of them together.
 */
export const TEMPLATE_READ_BATCH = 8;

/**
 * Drafts standing in for committed files: a change set's working copies,
 * for its author's live preview (#237). `ReadableContent.withOverlay` reads
 * through it, so every read is still filtered by the reader's scope; what
 * the overlay gives must already be the reader's own to see.
 */
export interface ContentOverlay {
  /**
   * Set apart what is read through the overlay: the reading key carries
   * it, so nothing cached for the files alone (a PDF, an ETag) is shared
   * with it, nor anything cached for it with the files.
   */
  readonly key: string;
  /** A module's draft in place of its file; `undefined`: the file. */
  module(id: string, lang: string): Promise<Module | undefined>;
  /**
   * A manual's draft manifest in place of its file (its entries may be
   * empty); `undefined`: the file.
   */
  manifest(id: string): Promise<Manifest | undefined>;
  /**
   * A page design's draft in place of its file (#392: the design screen's live preview);
   * `undefined`: the file.
   */
  pageDesign(id: string): Promise<PageDesign | undefined>;
  /**
   * The drafts of a page design template's files (#396: the template screen's preview), by path
   * in its folder; empty: the files. Read only once their lengths (`subjects`) are known to keep
   * the folder within the caps (#803).
   */
  templateFiles(id: string): Promise<ReadonlyMap<string, string>>;
  /** One template file's draft, by its path in the folder; `undefined`: the file. */
  templateFile(id: string, path: string): Promise<string | undefined>;
  /**
   * The modules, manuals, page designs and template files it holds a draft of; a template file's
   * with its text's length in UTF-8 bytes (`size`), known without reading it.
   */
  subjects(): Promise<{
    readonly modules: readonly ModuleFile[];
    readonly manuals: readonly string[];
    readonly designs: readonly string[];
    readonly templates: readonly {
      readonly templateId: string;
      readonly path: string;
      readonly size: number;
    }[];
  }>;
  /**
   * Whether the drafts may show an image the files alone would not: one
   * uploaded into the change set (its author's own bytes).
   */
  showsAsset(hash: string): Promise<boolean>;
}

/**
 * A snapshot with an overlay's drafts in place of their files. Everything
 * else (configuration, template, symbols) is the commit's. An image is
 * read only when a module the reader may see at the commit refers to it
 * (`committedAsset`) or the overlay shows it, so a draft naming any hash
 * reads no image it could not read otherwise.
 */
export class OverlaidSnapshot implements ContentSnapshot {
  readonly commit: string;
  readonly #modules = new Map<string, Promise<Module | undefined>>();
  readonly #manifests = new Map<string, Promise<Manifest | undefined>>();
  readonly #designs = new Map<string, Promise<PageDesign | undefined>>();
  readonly #templates = new Map<string, Promise<ReadonlyMap<string, string>>>();
  readonly #templateSizes = new Map<
    string,
    Promise<ReadonlyMap<string, number>>
  >();

  constructor(
    private readonly raw: ContentSnapshot,
    private readonly overlay: ContentOverlay,
    private readonly committedAsset: (hash: string) => Promise<boolean>,
  ) {
    this.commit = raw.commit;
  }

  config() {
    return this.raw.config();
  }

  async modules(lang?: string): Promise<ModuleFile[]> {
    const [files, { modules }] = await Promise.all([
      this.raw.modules(lang),
      this.overlay.subjects(),
    ]);
    const known = new Set(files.map((f) => `${f.lang}/${f.id}`));
    const added = modules.filter(
      (m) =>
        (lang === undefined || m.lang === lang) &&
        !known.has(`${m.lang}/${m.id}`),
    );
    return [...files, ...added.map((m) => ({ id: m.id, lang: m.lang }))];
  }

  async module(id: string, lang: string): Promise<Module | undefined> {
    return (await this.#draft(id, lang)) ?? this.raw.module(id, lang);
  }

  /** A draft's revision is its content's hash: equal drafts, equal revisions. */
  async moduleRevision(id: string, lang: string): Promise<string | undefined> {
    const draft = await this.#draft(id, lang);
    if (!draft) return this.raw.moduleRevision(id, lang);
    return `draft:${createHash('sha256').update(JSON.stringify(draft)).digest('hex')}`;
  }

  /** The committed history: a draft is no version of it. */
  moduleHistory(id: string, lang: string, max: number) {
    return this.raw.moduleHistory(id, lang, max);
  }

  /** What the commit deleted: a draft stands in for no history. */
  deletedModules(max: number) {
    return this.raw.deletedModules(max);
  }

  moduleAtRevision(id: string, lang: string, revision: string) {
    return this.raw.moduleAtRevision(id, lang, revision);
  }

  /** Terms are read from the commit: a working copy of one stands in for no reading. */
  terms(): Promise<string[]> {
    return this.raw.terms();
  }

  term(id: string) {
    return this.raw.term(id);
  }

  /** The commit's page designs and those only a draft holds (a design made in the change set). */
  async pageDesigns(): Promise<string[]> {
    const [ids, { designs }] = await Promise.all([
      this.raw.pageDesigns(),
      this.overlay.subjects(),
    ]);
    return [...new Set([...ids, ...designs])].sort();
  }

  /** A page design's draft (#392), else its file: the design screen previews what it edits. */
  async pageDesign(id: string): Promise<PageDesign | undefined> {
    let found = this.#designs.get(id);
    if (!found) {
      found = this.overlay.pageDesign(id);
      this.#designs.set(id, found);
    }
    return (await found) ?? this.raw.pageDesign(id);
  }

  /** Records are not drafted: the commit's, also next to a draft. */
  translationRecord(id: string, lang: string) {
    return this.raw.translationRecord(id, lang);
  }

  async manifests(): Promise<string[]> {
    const [ids, { manuals }] = await Promise.all([
      this.raw.manifests(),
      this.overlay.subjects(),
    ]);
    return [...new Set([...ids, ...manuals])].sort();
  }

  async manifest(id: string): Promise<Manifest | undefined> {
    let found = this.#manifests.get(id);
    if (!found) {
      found = this.overlay.manifest(id);
      this.#manifests.set(id, found);
    }
    return (await found) ?? this.raw.manifest(id);
  }

  /** A draft's revision is its content's hash, as a module draft's. */
  async manifestRevision(id: string): Promise<string | undefined> {
    const draft = await this.overlay.manifest(id);
    if (!draft) return this.raw.manifestRevision(id);
    return `draft:${createHash('sha256').update(JSON.stringify(draft)).digest('hex')}`;
  }

  /** The committed history: a draft is no version of it. */
  manifestHistory(id: string, max: number) {
    return this.raw.manifestHistory(id, max);
  }

  /** What the commit deleted: a draft stands in for no history. */
  deletedManifests(max: number) {
    return this.raw.deletedManifests(max);
  }

  manifestAtRevision(id: string, revision: string) {
    return this.raw.manifestAtRevision(id, revision);
  }

  resolve(
    manifest: Manifest,
    variant: VariantValues,
    lang: string,
    visible: (module: Module) => boolean,
    standIn?: ModuleStandIn,
  ): Promise<ManualResolution | undefined> {
    return this.raw.resolve(
      manifest,
      variant,
      lang,
      visible,
      async (id, l) => (await standIn?.(id, l)) ?? this.#draft(id, l),
    );
  }

  async asset(hash: string): Promise<Uint8Array | undefined> {
    const shown =
      (await this.overlay.showsAsset(hash)) ||
      (await this.committedAsset(hash));
    return shown ? this.raw.asset(hash) : undefined;
  }

  async hasAsset(hash: string): Promise<boolean> {
    const shown =
      (await this.overlay.showsAsset(hash)) ||
      (await this.committedAsset(hash));
    return shown && this.raw.hasAsset(hash);
  }

  symbols() {
    return this.raw.symbols();
  }

  /** The commit's file: only checks and the renderer's symbols read files. */
  file(path: string) {
    return this.raw.file(path);
  }

  template() {
    return this.raw.template();
  }

  /**
   * A page design template's files with its drafts in place of theirs, and the files only a draft
   * holds (#396: the template screen previews what it edits). The commit's alone when there is no
   * draft of it; undefined when there is no `manual.typ`, committed or drafted. Past the caps
   * (`MAX_TEMPLATE_FILES`, `MAX_TEMPLATE_BYTES`) the repository's `InvalidContentError`, told
   * from the listing and the drafts' lengths before anything is read (#803); within them the
   * committed files are read `TEMPLATE_READ_BATCH` at a time.
   */
  async designTemplate(
    id: string,
  ): Promise<Record<string, Uint8Array> | undefined> {
    const sizes = await this.#templateDraftSizes(id);
    if (sizes.size === 0) return this.raw.designTemplate(id);
    // The committed folder, also one without a `manual.typ` yet (the draft may add it).
    const listed = await this.raw.designTemplateListing(id);
    if (
      !sizes.has(DESIGN_TEMPLATE_ENTRY) &&
      !listed.some((file) => file.path === DESIGN_TEMPLATE_ENTRY)
    ) {
      return undefined;
    }
    refusePastTemplateCaps(id, templateFolderSize(listed, sizes));
    const drafts = await this.#templateDrafts(id);
    const files: Record<string, Uint8Array> = {};
    const unread = listed
      .map((file) => file.path)
      .filter((path) => !drafts.has(path));
    for (let i = 0; i < unread.length; i += TEMPLATE_READ_BATCH) {
      await Promise.all(
        unread.slice(i, i + TEMPLATE_READ_BATCH).map(async (path) => {
          const data = await this.raw.designTemplateFile(id, path);
          if (data) files[path] = data;
        }),
      );
    }
    const encoder = new TextEncoder();
    for (const [path, text] of drafts) files[path] = encoder.encode(text);
    return DESIGN_TEMPLATE_ENTRY in files ? files : undefined;
  }

  /** The commit's templates and those only a draft of their `manual.typ` makes. */
  async designTemplateIds(): Promise<readonly string[]> {
    const [ids, { templates }] = await Promise.all([
      this.raw.designTemplateIds(),
      this.overlay.subjects(),
    ]);
    const drafted = templates
      .filter((t) => t.path === DESIGN_TEMPLATE_ENTRY)
      .map((t) => t.templateId);
    return [...new Set([...ids, ...drafted])].sort();
  }

  /**
   * The commit's files of the folder with the drafts', each draft marked (`draft`) with its
   * length: every draft, also past the caps, and none of them read (#803).
   */
  async designTemplateListing(
    id: string,
  ): Promise<readonly TemplateFileEntry[]> {
    const [listed, sizes] = await Promise.all([
      this.raw.designTemplateListing(id),
      this.#templateDraftSizes(id),
    ]);
    const files = new Map(listed.map((file) => [file.path, file]));
    for (const [path, size] of sizes) {
      files.set(path, {
        path,
        size,
        draft: true,
        committed: files.get(path)?.committed ?? false,
      });
    }
    return [...files.values()].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
  }

  /** A template file's draft (that one read alone), else its file. */
  async designTemplateFile(
    id: string,
    path: string,
  ): Promise<Uint8Array | undefined> {
    const draft = (await this.#templateDraftSizes(id)).has(path)
      ? await this.overlay.templateFile(id, path)
      : undefined;
    return draft === undefined
      ? this.raw.designTemplateFile(id, path)
      : new TextEncoder().encode(draft);
  }

  /**
   * A hash of the template's drafts (paths and texts); empty when there is none. Past the caps
   * no draft is read (#803): a hash of the drafts' paths and lengths, marked as such, so a
   * rendering key is still made and the render itself answers the folder as its template's error
   * (`designTemplate`), as the commit's own folder past them is.
   */
  async designTemplateRevision(id: string): Promise<string> {
    const sizes = await this.#templateDraftSizes(id);
    if (sizes.size === 0) return this.raw.designTemplateRevision(id);
    const byPath = <T>(entries: Iterable<[string, T]>) =>
      [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const listed = await this.raw.designTemplateListing(id);
    if (pastTemplateCaps(templateFolderSize(listed, sizes))) {
      return `past-caps:${createHash('sha256')
        .update(JSON.stringify(byPath(sizes)))
        .digest('hex')}`;
    }
    const drafts = await this.#templateDrafts(id);
    return `draft:${createHash('sha256')
      .update(JSON.stringify(byPath(drafts)))
      .digest('hex')}`;
  }

  /** The lengths of a template's drafts (UTF-8 bytes) by path, from `subjects`: nothing is read. */
  #templateDraftSizes(id: string): Promise<ReadonlyMap<string, number>> {
    let found = this.#templateSizes.get(id);
    if (!found) {
      found = this.overlay
        .subjects()
        .then(
          ({ templates }) =>
            new Map(
              templates
                .filter((t) => t.templateId === id)
                .map((t) => [t.path, t.size]),
            ),
        );
      this.#templateSizes.set(id, found);
    }
    return found;
  }

  /** The overlay's drafts of a template's files, read once per snapshot. */
  #templateDrafts(id: string): Promise<ReadonlyMap<string, string>> {
    let found = this.#templates.get(id);
    if (!found) {
      found = this.overlay.templateFiles(id);
      this.#templates.set(id, found);
    }
    return found;
  }

  committedAt() {
    return this.raw.committedAt();
  }

  /** The overlay's draft of a module, read once per snapshot. */
  #draft(id: string, lang: string): Promise<Module | undefined> {
    const key = `${lang}/${id}`;
    let found = this.#modules.get(key);
    if (!found) {
      found = this.overlay.module(id, lang);
      this.#modules.set(key, found);
    }
    return found;
  }
}
