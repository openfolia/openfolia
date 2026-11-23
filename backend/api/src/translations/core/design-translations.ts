import {
  compareDesignWithRecord,
  hasDesignTranslation,
  type PageDesign,
  PageDesignId,
  pageDesignIdFor,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import { allowsAllIn, allowsUnrestricted } from '../../access/core/allows.js';
import { InvalidContentError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type {
  BlockStatus,
  TranslationState,
  TranslationStatus,
} from './translation-status.js';

/**
 * A page design's region text in the translation status, the jobs and XLIFF (#568) is keyed
 * like a module, by `design.<designId>`: the `moduleId` of its job units, its `<file id>` in an
 * XLIFF document. A module ID is a slug without a dot, so no module takes such a key; and it is
 * an XML name token, as XLIFF's `id` must be. Its units are keyed `<slot>.<block>`
 * (`DesignUnitKey`).
 */
export const DESIGN_KEY_PREFIX = 'design.';

/** The key a design's region text has where a module's ID goes (`DESIGN_KEY_PREFIX`). */
export const designKey = (designId: string): string =>
  `${DESIGN_KEY_PREFIX}${designId}`;

/** The design a key (`designKey`) names; undefined for a module's ID or anything else. */
export function designIdOf(key: string): string | undefined {
  if (!key.startsWith(DESIGN_KEY_PREFIX)) return undefined;
  const id = key.slice(DESIGN_KEY_PREFIX.length);
  return PageDesignId.safeParse(id).success ? id : undefined;
}

/**
 * Whether `actor` manages the translation of page designs into `lang`: `translation.manage`
 * in a role whose scope restricts nothing but languages, `lang` among them (`allowsAllIn`).
 * A design is every manual's look, of every audience and module type, so a role limited to
 * some of them manages none, as a term's languages are judged.
 */
export function managesDesignIn(actor: Actor, lang: string): boolean {
  return allowsAllIn(actor, 'translation.manage', lang);
}

/**
 * Whether `actor` may change page designs: `content.edit` in a role whose scope restricts
 * nothing, as the change-set actions require of a design (`checkDesignChange`). An import
 * writes a design's translation through them.
 */
export function changesDesigns(actor: Actor): boolean {
  return allowsUnrestricted(actor, 'content.edit');
}

/**
 * The page designs at the reader's commit that can be read, ordered by name (case and accents
 * aside), then ID. Designs carry no audience: every reader of the commit reads them all.
 */
export async function readableDesigns(
  snapshot: ReadableContent,
): Promise<PageDesign[]> {
  const designs = (await snapshot.pageDesigns()).flatMap((entry) =>
    'design' in entry ? [entry.design] : [],
  );
  return designs.sort(
    (a, b) => names.compare(a.name, b.name) || ids.compare(a.id, b.id),
  );
}

const names = new Intl.Collator(undefined, { sensitivity: 'base' });
const ids = new Intl.Collator();

/** A design as the reader reads it; one that cannot be read is none. */
export async function readDesign(
  snapshot: ReadableContent,
  id: string,
): Promise<PageDesign | undefined> {
  try {
    return await snapshot.pageDesign(id);
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
}

/**
 * The page design a manual is laid out with (its manifest's, else the configuration's
 * `pdf.design`), as the reader reads the manual; none for the built-in design, or a manual
 * they may not see or that cannot be read.
 */
export async function manualDesignId(
  snapshot: ReadableContent,
  manualId: string,
  config: ProjectConfig,
): Promise<string | undefined> {
  let manual: Awaited<ReturnType<ReadableContent['manual']>>;
  try {
    manual = await snapshot.manual(manualId);
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
  if (!manual) return undefined;
  const id = pageDesignIdFor(manual.manifest, config);
  return PageDesignId.safeParse(id).success ? id : undefined;
}

/**
 * A design's region text in `lang` (#568), as a module's status: each unit at a provider
 * (`atProvider`, unit keys) is `at-provider`, else as `compareDesignWithRecord` finds it
 * (`missing` where the region has no text of its own in `lang`). The design is `missing`
 * while no region has text of its own in `lang` (and some unit is due or none is at a
 * provider), else `outdated` while any unit not at a provider is due, else `at-provider` while
 * any is, else `up-to-date`. Undefined for a design without region text: nothing to translate.
 */
export function designTranslationStatus(input: {
  readonly design: PageDesign;
  readonly lang: string;
  readonly source: string;
  readonly atProvider: ReadonlySet<string>;
}): TranslationStatus | undefined {
  const { design, lang, source, atProvider } = input;
  const compared = compareDesignWithRecord(design, lang, source);
  if (compared.length === 0) return undefined;
  const translated = hasDesignTranslation(design, lang, source);
  const blocks = compared.map(({ blockId, state }): BlockStatus => ({
    blockId,
    state: atProvider.has(blockId) ? 'at-provider' : state,
  }));
  const outdatedBlocks = blocks.filter(
    (b) => b.state === 'outdated' || b.state === 'missing',
  ).length;
  const atProviderBlocks = blocks.filter(
    (b) => b.state === 'at-provider',
  ).length;
  const state: TranslationState =
    !translated && (outdatedBlocks > 0 || atProviderBlocks === 0)
      ? 'missing'
      : outdatedBlocks > 0
        ? 'outdated'
        : atProviderBlocks > 0
          ? 'at-provider'
          : 'up-to-date';
  const record =
    design.translations !== undefined &&
    Object.hasOwn(design.translations, lang)
      ? design.translations[lang]
      : undefined;
  return {
    kind: 'design',
    moduleId: designKey(design.id),
    lang,
    title: design.name,
    state,
    blocks,
    outdatedBlocks,
    atProviderBlocks,
    sourceCommit: translated && record ? record.sourceCommit : null,
  };
}
