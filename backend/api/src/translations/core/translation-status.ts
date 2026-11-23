import {
  compareWithRecord,
  type Module,
  type TranslationRecord,
} from '@openfolia/content-model';
import { InvalidContentError } from '../../base/core/errors.js';
import type { ReadableContent } from '../../content/core/readable-content.js';

/**
 * Where a module's translation into one language stands, or one block's:
 *
 * - `up-to-date`: translated from the source text it has now;
 * - `outdated`: the source changed since (or the block was never
 *   translated, or the translation has no record);
 * - `missing`: there is no file in that language;
 * - `at-provider`: sent to a translation provider, not back yet.
 */
export const TRANSLATION_STATES = [
  'up-to-date',
  'outdated',
  'missing',
  'at-provider',
] as const;
export type TranslationState = (typeof TRANSLATION_STATES)[number];

export interface BlockStatus {
  readonly blockId: string;
  readonly state: TranslationState;
}

/**
 * What a status is of: a source module, a page design's region text (#568), a manual's own text
 * (#656), or the configuration's labels (#731).
 */
export const TRANSLATION_STATUS_KINDS = [
  'module',
  'design',
  'manual',
  'config',
] as const;
export type TranslationStatusKind = (typeof TRANSLATION_STATUS_KINDS)[number];

/**
 * One source module in one target language, or a page design's region text (#568, `kind`
 * `design`: `moduleId` is its key, `designKey`, and its blocks are units keyed
 * `<slot>.<block>`), or a manual's cover image alternative text (#656, `kind` `manual`:
 * `moduleId` is its key, `manualKey`, its units keyed `title`, `group.…`, `coverImage.…`), or
 * the configuration's labels (#731, `kind` `config`: `moduleId` is `config.project`, its units
 * keyed by `ConfigUnitKey`).
 */
export interface TranslationStatus {
  readonly kind: TranslationStatusKind;
  readonly moduleId: string;
  readonly lang: string;
  /** The source module's title. */
  readonly title: string;
  readonly state: TranslationState;
  /** Every translatable unit of the source module, in document order. */
  readonly blocks: readonly BlockStatus[];
  /** The units that need translating: `outdated` or `missing`, and not at a provider. */
  readonly outdatedBlocks: number;
  readonly atProviderBlocks: number;
  /** The commit the translation was made from (its record's); null without a record. */
  readonly sourceCommit: string | null;
}

/**
 * The status of `source` (a source-language module) in `lang`: each block
 * at a provider (`atProvider`, block IDs) is `at-provider`; otherwise,
 * without a translated file every block is `missing`, and with one it is
 * compared with the file's record (`compareWithRecord`: without a record
 * every block is `outdated`). The module is `missing` or `outdated` while
 * any block that is not at a provider is, else `at-provider` while any
 * block is, else `up-to-date` (also with no translatable block at all and
 * a file there).
 */
export function translationStatus(input: {
  readonly source: Module;
  readonly lang: string;
  readonly translated: boolean;
  readonly record: TranslationRecord | undefined;
  readonly atProvider: ReadonlySet<string>;
}): TranslationStatus {
  const { source, lang, translated, record, atProvider } = input;
  const blocks = compareWithRecord(source, translated ? record : undefined).map(
    ({ blockId, state }): BlockStatus => ({
      blockId,
      state: atProvider.has(blockId)
        ? 'at-provider'
        : translated
          ? state
          : 'missing',
    }),
  );
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
  return {
    kind: 'module',
    moduleId: source.id,
    lang,
    title: source.meta.title,
    state,
    blocks,
    outdatedBlocks,
    atProviderBlocks,
    sourceCommit: translated && record ? record.sourceCommit : null,
  };
}

/**
 * Whether `lang`'s translation of `source` (a source-language module the
 * reader sees) is there for the reader, with its record: `undefined` when
 * the reader may not see a translation in `lang` (outside their scope, so
 * it is not listed at all), else whether a file is there. A translated
 * file the reader may not see (another audience, say) counts as missing,
 * as resolving treats it; a broken one is there, without a record (every
 * block outdated). A record that cannot be read counts as none.
 */
export async function readTranslation(
  snapshot: ReadableContent,
  source: Module,
  lang: string,
): Promise<
  | { readonly translated: boolean; readonly record?: TranslationRecord }
  | undefined
> {
  let target: Module | undefined;
  try {
    target = await snapshot.module(source.id, lang);
  } catch (error) {
    if (!(error instanceof InvalidContentError)) throw error;
    return { translated: true };
  }
  if (!target) {
    const translated = { ...source, meta: { ...source.meta, lang } };
    return (await snapshot.wouldSee({ module: translated }))
      ? { translated: false }
      : undefined;
  }
  try {
    const record = await snapshot.translationRecord(source.id, lang);
    return record ? { translated: true, record } : { translated: true };
  } catch (error) {
    if (!(error instanceof InvalidContentError)) throw error;
    return { translated: true };
  }
}
