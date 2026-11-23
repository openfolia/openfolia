import {
  deriveManifest,
  noticeRuleOf,
  readGatheringModules,
  sourceModuleIds,
  type DeriveResult,
  type Issue,
  type Manifest,
  type Module,
  type VariantValues,
} from '@openfolia/content-model';
import { InvalidContentError } from '../../base/core/errors.js';
import type {
  ContentSnapshot,
  ManualResolution,
  ModuleStandIn,
} from './content.repository.js';

/**
 * A snapshot whose derived manuals (#451, `kind: derived`) have their entries gathered from
 * their source manual (`deriveManifest`), so everything that reads a manifest (the manual and
 * its listing, checks, translation status, release outputs and their changes, the exports, the
 * module index) reads a derived manual as any manual. Gathered from what this snapshot reads:
 * with an overlay's drafts under it, from the drafts. A manifest of an earlier revision is
 * gathered from this commit's content, as its entries are not stored. Its text attributes stay
 * its own (so it prints back to its file); `textAttributes` gives the ones to resolve it with,
 * its source's under its own. Everything else is the snapshot's.
 * Read once per manual per snapshot.
 *
 * `sees` decides whether a source manual may be gathered from, for the reader this is read for
 * (`ReadableContent`: whether they may see the source manual): one they may not is gathered
 * from as a source that does not exist, so nothing of it (its entries, its text attributes,
 * whether it exists or is derived itself) shows through the derived manual. `seesModule`, for a
 * notice gathering (#670), whether a module may be read for the reader: one they may not is read
 * as one that does not exist, so nothing about its notices shows.
 */

/** Whether a derived manual may be gathered from `source` for the reader. */
export type SeesSource = (source: Manifest) => Promise<boolean>;

/**
 * Whether a notice gathering (#670) may read a module for the reader: one they may not see
 * counts as one that does not exist, so whether it holds notices (and so whether a module
 * referring to it is gathered, or a notice is reported left out) does not show.
 */
export type SeesModule = (id: string) => Promise<boolean>;

/** Source modules read at once (for their types; for a notice gathering, their notices). */
const MODULES_AT_ONCE = 32;

export class DerivedManuals implements ContentSnapshot {
  readonly commit: string;
  readonly #derived = new Map<string, Promise<DeriveResult>>();
  readonly #raw: ContentSnapshot;
  readonly #sees: SeesSource | undefined;
  readonly #seesModule: SeesModule | undefined;

  /**
   * Without `sees` (every source gathered from): `raw` itself when it is one already, so what
   * it reads is gathered once. With `sees`: one gathering for that reader, over `raw`'s
   * snapshot.
   */
  static of(
    raw: ContentSnapshot,
    sees?: SeesSource,
    seesModule?: SeesModule,
  ): DerivedManuals {
    if (raw instanceof DerivedManuals) {
      // One reader's gathering is never another's, nor everyone's.
      return !sees && !seesModule && !raw.#sees && !raw.#seesModule
        ? raw
        : new DerivedManuals(raw.#raw, sees, seesModule);
    }
    return new DerivedManuals(raw, sees, seesModule);
  }

  private constructor(
    raw: ContentSnapshot,
    sees: SeesSource | undefined,
    seesModule: SeesModule | undefined,
  ) {
    this.#raw = raw;
    this.#sees = sees;
    this.#seesModule = seesModule;
    this.commit = raw.commit;
  }

  /**
   * What deriving a manual found (`unknown-source-manual`, `safety-module-excluded`, …); none
   * for an assembled manual, one that does not exist and one that cannot be read.
   */
  async derivationIssues(id: string): Promise<readonly Issue[]> {
    let manifest: Manifest | undefined;
    try {
      manifest = await this.#raw.manifest(id);
    } catch (error) {
      if (error instanceof InvalidContentError) return [];
      throw error;
    }
    if (manifest?.kind !== 'derived') return [];
    return (await this.#derive(manifest)).issues;
  }

  /**
   * Whether a manual is a derived one here (its entries then depend on other files than its
   * own); false for one that does not exist or cannot be read.
   */
  async isDerived(id: string): Promise<boolean> {
    try {
      return (await this.#raw.manifest(id))?.kind === 'derived';
    } catch (error) {
      if (error instanceof InvalidContentError) return false;
      throw error;
    }
  }

  /**
   * Whether a manual is a derived one gathering safety notices here (#670), by its stored file,
   * without gathering it; false for one that does not exist or cannot be read.
   */
  async gathersNotices(id: string): Promise<boolean> {
    try {
      const manifest = await this.#raw.manifest(id);
      return manifest !== undefined && noticeRuleOf(manifest) !== undefined;
    } catch (error) {
      if (error instanceof InvalidContentError) return false;
      throw error;
    }
  }

  async manifest(id: string): Promise<Manifest | undefined> {
    const manifest = await this.#raw.manifest(id);
    if (manifest?.kind !== 'derived') return manifest;
    return (await this.#derive(manifest)).manifest;
  }

  async manifestAtRevision(
    id: string,
    revision: string,
  ): Promise<Manifest | undefined> {
    const manifest = await this.#raw.manifestAtRevision(id, revision);
    if (manifest?.kind !== 'derived') return manifest;
    return (await this.#gather(manifest)).manifest;
  }

  /**
   * The text attributes to resolve a manual with: a derived manual's source's with its own over
   * them (#451), any other manual's own.
   */
  async textAttributes(manifest: Manifest): Promise<Manifest['attributes']> {
    if (manifest.kind !== 'derived') return manifest.attributes;
    const stored = await this.#raw.manifest(manifest.id);
    // The stored manual's gathering only for what gathers alike (an earlier revision may not).
    const derived =
      stored?.kind === 'derived' &&
      stored.audience === manifest.audience &&
      JSON.stringify(stored.rule) === JSON.stringify(manifest.rule)
        ? await this.#derive(stored)
        : await this.#gather(manifest);
    return { ...derived.attributes, ...manifest.attributes };
  }

  resolve(
    manifest: Manifest,
    variant: VariantValues,
    lang: string,
    visible: (module: Module) => boolean,
    standIn?: ModuleStandIn,
  ): Promise<ManualResolution | undefined> {
    return this.#raw.resolve(manifest, variant, lang, visible, standIn);
  }

  /** The stored derived manual `manifest` gathered, once per snapshot. */
  #derive(manifest: Manifest): Promise<DeriveResult> {
    let found = this.#derived.get(manifest.id);
    if (!found) {
      found = this.#gather(manifest);
      this.#derived.set(manifest.id, found);
      // A failure (the repository unreachable) is not kept.
      found.catch(() => this.#derived.delete(manifest.id));
    }
    return found;
  }

  /**
   * Gathers a derived manual: its source manifest as stored here (`unreadable` when it cannot be
   * read), the types of the modules it includes from their source-language files (one that
   * cannot be read is not gathered; its own checks report it).
   */
  async #gather(manifest: Manifest): Promise<DeriveResult> {
    const rule = manifest.rule;
    const config = await this.#raw.config();
    let source: Manifest | 'unreadable' | undefined;
    if (rule) {
      try {
        source = await this.#raw.manifest(rule.source);
      } catch (error) {
        if (!(error instanceof InvalidContentError)) throw error;
        source = 'unreadable';
      }
      // A source hidden from the reader is one that does not exist, for them.
      if (source && source !== 'unreadable' && this.#sees) {
        if (!(await this.#sees(source))) source = undefined;
      }
    }
    let modules = new Map<string, Module>();
    if (rule && source !== undefined && source !== 'unreadable') {
      // A notice gathering (#670) reads the modules referred to as well, and the front and
      // back matter, whose notices show whole.
      const notices = rule.notices !== undefined;
      modules = await readGatheringModules(
        notices
          ? [...sourceModuleIds(source), ...rule.front, ...rule.back]
          : sourceModuleIds(source),
        async (id) => {
          // For the reader: a module they may not see holds nothing (#670).
          if (notices && this.#seesModule && !(await this.#seesModule(id))) {
            return undefined;
          }
          try {
            return await this.#raw.module(id, config.languages.source);
          } catch (error) {
            if (!(error instanceof InvalidContentError)) throw error;
            return undefined;
          }
        },
        { followReferences: notices, atOnce: MODULES_AT_ONCE },
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

  config() {
    return this.#raw.config();
  }
  modules(lang?: string) {
    return this.#raw.modules(lang);
  }
  module(id: string, lang: string) {
    return this.#raw.module(id, lang);
  }
  moduleRevision(id: string, lang: string) {
    return this.#raw.moduleRevision(id, lang);
  }
  moduleHistory(id: string, lang: string, max: number) {
    return this.#raw.moduleHistory(id, lang, max);
  }
  deletedModules(max: number) {
    return this.#raw.deletedModules(max);
  }
  moduleAtRevision(id: string, lang: string, revision: string) {
    return this.#raw.moduleAtRevision(id, lang, revision);
  }
  translationRecord(id: string, lang: string) {
    return this.#raw.translationRecord(id, lang);
  }
  manifests() {
    return this.#raw.manifests();
  }
  terms() {
    return this.#raw.terms();
  }
  term(id: string) {
    return this.#raw.term(id);
  }
  pageDesigns() {
    return this.#raw.pageDesigns();
  }
  pageDesign(id: string) {
    return this.#raw.pageDesign(id);
  }
  manifestRevision(id: string) {
    return this.#raw.manifestRevision(id);
  }
  manifestHistory(id: string, max: number) {
    return this.#raw.manifestHistory(id, max);
  }
  deletedManifests(max: number) {
    return this.#raw.deletedManifests(max);
  }
  asset(hash: string) {
    return this.#raw.asset(hash);
  }
  hasAsset(hash: string) {
    return this.#raw.hasAsset(hash);
  }
  symbols() {
    return this.#raw.symbols();
  }
  file(path: string) {
    return this.#raw.file(path);
  }
  template() {
    return this.#raw.template();
  }
  designTemplate(id: string) {
    return this.#raw.designTemplate(id);
  }
  designTemplateIds() {
    return this.#raw.designTemplateIds();
  }
  designTemplateListing(id: string) {
    return this.#raw.designTemplateListing(id);
  }
  designTemplateFile(id: string, path: string) {
    return this.#raw.designTemplateFile(id, path);
  }
  designTemplateRevision(id: string) {
    return this.#raw.designTemplateRevision(id);
  }
  committedAt() {
    return this.#raw.committedAt();
  }
}
