import {
  walk,
  type ManifestEntry,
  type Module,
  type ModuleMeta,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import { allows, ANYWHERE } from '../../access/core/allows.js';
import { ForbiddenError, InvalidContentError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { CONFIG_KEY, configTranslationStatus } from './config-translations.js';
import {
  designKey,
  designTranslationStatus,
  readDesign,
} from './design-translations.js';
import type { TranslationJobs } from './translation-jobs.js';
import {
  manualKey,
  manualTranslationStatus,
  readManifest,
  seesManualTranslation,
} from './manual-translations.js';
import {
  readTranslation,
  translationStatus,
  type TranslationState,
  type TranslationStatus,
  type TranslationStatusKind,
} from './translation-status.js';

/**
 * Who may read translation status: a translation manager
 * (`translation.manage`) or a reader of drafts (`content.read.draft`), in
 * any scope; what they see is then limited by their reading scope. Reading
 * content (`content.read`) is checked first, by opening the ref.
 */
export function authorizeTranslationStatus(actor: Actor): void {
  if (
    !allows(actor, 'translation.manage', ANYWHERE) &&
    !allows(actor, 'content.read.draft', ANYWHERE)
  ) {
    throw new ForbiddenError(
      'This needs the translation.manage or the content.read.draft permission.',
    );
  }
}

/** What to list; every part given has to hold. */
export interface TranslationStatusFilter {
  /** A target language; any other matches nothing. */
  readonly lang?: string | undefined;
  /** Only the modules this manual includes (also through module references). */
  readonly manual?: string | undefined;
  /**
   * A folder of the content browser: a module type (`procedure`), or a
   * module type and a value of the first configured facet
   * (`procedure/north`).
   */
  readonly folder?: string | undefined;
  readonly state?: TranslationState | undefined;
  /** Text in the source module's title or its ID (a design's name or ID), case and diacritics aside. */
  readonly q?: string | undefined;
  /**
   * Only modules, only page designs' region text (#568), only manuals' own text (#656), or only
   * the configuration's labels (#731).
   */
  readonly kind?: TranslationStatusKind | undefined;
  /**
   * Only these source modules (#694: a page of the content list), so no page design, no
   * manual and no labels. An ID the reader sees no source module of matches nothing.
   */
  readonly modules?: ReadonlySet<string> | undefined;
}

/**
 * One source module's status in `lang`, or `undefined` when there is none
 * for the reader: `lang` is no target language, the source module is not
 * there for them, or they would not see a translation in `lang`.
 */
export async function getTranslationStatus(
  snapshot: ReadableContent,
  jobs: TranslationJobs,
  moduleId: string,
  lang: string,
): Promise<TranslationStatus | undefined> {
  const config = await snapshot.config();
  if (!config.languages.targets.includes(lang)) return undefined;
  const source = await readModule(snapshot, moduleId, config.languages.source);
  if (!source) return undefined;
  return statusOf(snapshot, source, lang, await unitsAtProvider(jobs, lang));
}

/**
 * A page design's region text in `lang` (#568), or `undefined` when there is none: `lang` is
 * no target language, there is no such design (or it cannot be read), or it has no region text.
 */
export async function getDesignTranslationStatus(
  snapshot: ReadableContent,
  jobs: TranslationJobs,
  designId: string,
  lang: string,
): Promise<TranslationStatus | undefined> {
  const config = await snapshot.config();
  if (!config.languages.targets.includes(lang)) return undefined;
  const design = await readDesign(snapshot, designId);
  if (!design) return undefined;
  const atProvider = await unitsAtProvider(jobs, lang);
  return designTranslationStatus({
    design,
    lang,
    source: config.languages.source,
    atProvider: atProvider.get(`${lang}/${designKey(designId)}`) ?? new Set(),
  });
}

/**
 * The configuration's labels in `lang` (#731), or `undefined` when there are none to translate:
 * `lang` is no target language, or no label has source-language text. Every reader of the
 * commit reads the configuration, in every language.
 */
export async function getConfigTranslationStatus(
  snapshot: ReadableContent,
  jobs: TranslationJobs,
  lang: string,
): Promise<TranslationStatus | undefined> {
  const config = await snapshot.config();
  if (!config.languages.targets.includes(lang)) return undefined;
  const atProvider = await unitsAtProvider(jobs, lang);
  return configTranslationStatus({
    config,
    lang,
    atProvider: atProvider.get(`${lang}/${CONFIG_KEY}`) ?? new Set(),
  });
}

/**
 * A manual's cover image alternative text in `lang` (#656), or `undefined` when there is none:
 * `lang` is no target language, there is no such manual for the reader (or it cannot be read),
 * they would not read it in `lang` (`seesManualTranslation`), or it has no such text.
 */
export async function getManualTranslationStatus(
  snapshot: ReadableContent,
  jobs: TranslationJobs,
  manualId: string,
  lang: string,
): Promise<TranslationStatus | undefined> {
  const config = await snapshot.config();
  if (!config.languages.targets.includes(lang)) return undefined;
  const manifest = await readManifest(snapshot, manualId);
  if (!manifest || !(await seesManualTranslation(snapshot, manifest, lang))) {
    return undefined;
  }
  const atProvider = await unitsAtProvider(jobs, lang);
  return manualTranslationStatus({
    manualId,
    manifest,
    lang,
    source: config.languages.source,
    atProvider: atProvider.get(`${lang}/${manualKey(manualId)}`) ?? new Set(),
  });
}

async function statusOf(
  snapshot: ReadableContent,
  source: Module,
  lang: string,
  atProvider: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<TranslationStatus | undefined> {
  const found = await readTranslation(snapshot, source, lang);
  if (!found) return undefined;
  return translationStatus({
    source,
    lang,
    translated: found.translated,
    record: found.record,
    atProvider: atProvider.get(`${lang}/${source.id}`) ?? new Set(),
  });
}

/** A module as the reader sees it in `lang`; a broken file is none here. */
export async function readModule(
  snapshot: ReadableContent,
  id: string,
  lang: string,
): Promise<Module | undefined> {
  try {
    return await snapshot.module(id, lang);
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
}

/** `lang/moduleId` → the block IDs at a provider. */
export async function unitsAtProvider(
  jobs: TranslationJobs,
  lang: string | undefined,
): Promise<Map<string, Set<string>>> {
  const units = await jobs.unitsAtProvider({ lang });
  const byModule = new Map<string, Set<string>>();
  for (const unit of units) {
    const key = `${unit.lang}/${unit.moduleId}`;
    const blocks = byModule.get(key) ?? new Set<string>();
    blocks.add(unit.blockId);
    byModule.set(key, blocks);
  }
  return byModule;
}

/** Whether a module (by its metadata) is in a folder of the content browser. */
export function inFolder(
  meta: Pick<ModuleMeta, 'type' | 'facets'>,
  folder: string | undefined,
  config: ProjectConfig,
): boolean {
  if (folder === undefined) return true;
  const [type, value, ...rest] = folder.split('/');
  if (rest.length > 0 || meta.type !== type) return false;
  if (value === undefined) return true;
  const facet = config.facets[0];
  return facet !== undefined && (meta.facets[facet.id] ?? []).includes(value);
}

/**
 * The IDs of the modules a manual includes, as the reader reads its
 * manifest, and those their module references lead to (in the source
 * language, as the reader sees them); none for a manual the reader may not
 * see.
 */
export async function manualModules(
  snapshot: ReadableContent,
  manualId: string,
  source: string,
): Promise<Set<string>> {
  const found = new Set<string>();
  let manual: Awaited<ReturnType<ReadableContent['manual']>>;
  try {
    manual = await snapshot.manual(manualId);
  } catch (error) {
    // A manifest that cannot be read names nothing.
    if (error instanceof InvalidContentError) return found;
    throw error;
  }
  if (!manual) return found;
  const pending = named(manual.manifest.entries);
  while (pending.length > 0) {
    const id = pending.shift() as string;
    if (found.has(id)) continue;
    found.add(id);
    const module = await readModule(snapshot, id, source);
    for (const { kind, node } of walk(module?.blocks ?? [])) {
      if (kind === 'block' && node.type === 'moduleRef') {
        pending.push(node.module);
      }
    }
  }
  return found;
}

function named(entries: readonly ManifestEntry[]): string[] {
  return entries.flatMap((entry) =>
    'module' in entry ? [entry.module] : named(entry.entries),
  );
}
