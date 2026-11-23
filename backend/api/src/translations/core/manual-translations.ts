import {
  compareManifestWithRecord,
  hasManifestTranslation,
  type Manifest,
  manifestRecord,
  ModuleId,
  textIn,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import { allowsManual } from '../../access/core/allows.js';
import { ForbiddenError, InvalidContentError } from '../../base/core/errors.js';
import { checkCommittedManual } from '../../change-sets/core/subject-scope.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import type {
  BlockStatus,
  TranslationState,
  TranslationStatus,
} from './translation-status.js';

/**
 * A manifest's translatable text (its title and group titles, #731; its cover images' alternative
 * text, #656) in the translation
 * status, the jobs and XLIFF is keyed like a module, by `manual.<manualId>`: the `moduleId` of its
 * job units, its `<file id>` in an XLIFF document. A module ID is a slug without a dot, and a
 * design's key starts `design.`, so neither takes such a key; and it is an XML name token, as
 * XLIFF's `id` must be. Its units are keyed `title`, `group.<hex>`, `coverImage.default` and
 * `coverImage.variant-<hex>` (`ManifestUnitKey`).
 */
export const MANUAL_KEY_PREFIX = 'manual.';

/** The key a manifest's translatable text has where a module's ID goes (`MANUAL_KEY_PREFIX`). */
export const manualKey = (manualId: string): string =>
  `${MANUAL_KEY_PREFIX}${manualId}`;

/** The manual a key (`manualKey`) names; undefined for a module's ID, a design's key or anything else. */
export function manualIdOf(key: string): string | undefined {
  if (!key.startsWith(MANUAL_KEY_PREFIX)) return undefined;
  const id = key.slice(MANUAL_KEY_PREFIX.length);
  return ModuleId.safeParse(id).success ? id : undefined;
}

/** A manual's manifest as the reader reads it; one they may not see, or that cannot be read, is none. */
export async function readManifest(
  snapshot: ReadableContent,
  manualId: string,
): Promise<Manifest | undefined> {
  try {
    return (await snapshot.manual(manualId))?.manifest;
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
}

/**
 * Whether the reader would read the manual's translation into `lang` (`seesManualIn`, as the
 * coverage report decides it): where its text in `lang` is listed at all.
 */
export function seesManualTranslation(
  snapshot: ReadableContent,
  manifest: Pick<Manifest, 'audience'>,
  lang: string,
): Promise<boolean> {
  return snapshot.seesManualIn(manifest.audience, lang);
}

/**
 * Whether `actor` manages the translation of a manual's own text into `lang`:
 * `translation.manage` in a role whose audience covers the manual's and whose languages hold
 * `lang` (`allowsManual`), as a module's languages and audience are judged.
 */
export async function managesManualIn(
  actor: Actor,
  snapshot: ReadableContent,
  manifest: Pick<Manifest, 'audience'>,
  lang: string,
): Promise<boolean> {
  const audiences = (await snapshot.config()).audiences.map((a) => a.id);
  return allowsManual(actor, 'translation.manage', {
    audiences,
    audience: manifest.audience,
    lang,
  });
}

/**
 * Whether `actor` may change the manual's manifest at `snapshot` (`checkCommittedManual`, which
 * locking it and saving its working copy check again): `content.edit` over its audience, and
 * reading all of it (no entry hidden from them, so writing it back loses nothing). An import
 * writes the manifest's translations through those actions.
 */
export async function changesManual(
  actor: Actor,
  snapshot: ReadableContent,
  manualId: string,
): Promise<boolean> {
  try {
    await checkCommittedManual(actor, snapshot, { type: 'manual', manualId });
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

/**
 * A manifest's translatable text in `lang` (#656), as a module's status: each unit at a provider
 * (`atProvider`, unit keys) is `at-provider`, else as `compareManifestWithRecord` finds it
 * (`missing` where a title or alternative text has no version in `lang`). The manual is `missing`
 * while no unit has text of its own in `lang` (and some unit is due or none is at a provider),
 * else `outdated` while any unit not at a provider is due, else `at-provider` while any is, else
 * `up-to-date`. Undefined only for a manifest without units (none: its title is one, #731).
 */
export function manualTranslationStatus(input: {
  readonly manualId: string;
  readonly manifest: Pick<
    Manifest,
    'title' | 'entries' | 'coverImage' | 'translations'
  >;
  readonly lang: string;
  readonly source: string;
  readonly atProvider: ReadonlySet<string>;
}): TranslationStatus | undefined {
  const { manualId, manifest, lang, source, atProvider } = input;
  const compared = compareManifestWithRecord(manifest, lang, source);
  if (compared.length === 0) return undefined;
  const translated = hasManifestTranslation(manifest, lang, source);
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
  const record = manifestRecord(manifest, lang);
  return {
    kind: 'manual',
    moduleId: manualKey(manualId),
    lang,
    title: textIn(manifest.title, source, source),
    state,
    blocks,
    outdatedBlocks,
    atProviderBlocks,
    sourceCommit: translated && record ? record.sourceCommit : null,
  };
}
