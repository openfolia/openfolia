import {
  compareConfigWithRecord,
  configRecord,
  hasConfigTranslation,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { Actor } from '../../access/core/actor.js';
import { allowsAllIn } from '../../access/core/allows.js';
import { ForbiddenError } from '../../base/core/errors.js';
import { checkConfigChange } from '../../change-sets/core/subject-scope.js';
import { foldText } from '../../content/core/module-filter.js';
import type {
  BlockStatus,
  TranslationState,
  TranslationStatus,
} from './translation-status.js';

/**
 * The configuration's labels (#731: module types', audiences', facets' and their values',
 * variant attributes' and their values', text attributes', safety symbols', callout styles') in
 * the translation status, the jobs and XLIFF are keyed like a module, by `config.project`: the
 * `moduleId` of its job units, its `<file id>` in an XLIFF document. A module ID is a slug
 * without a dot, and a design's and a manual's keys start otherwise, so nothing else takes it;
 * it is an XML name token, as XLIFF's `id` must be. Its units are keyed by `ConfigUnitKey`
 * (`moduleTypes.<id>`, `facets.<id>.<value>`, …).
 */
export const CONFIG_KEY = 'config.project';

/** The repository file the labels live in, as an XLIFF `<file original>` names it. */
export const CONFIG_ORIGINAL = 'openfolia.yaml';

/** Whether a key names the configuration's labels (`CONFIG_KEY`). */
export const isConfigKey = (key: string): boolean => key === CONFIG_KEY;

/** The title the configuration's status is listed by. */
export const CONFIG_TITLE = 'Project labels';

/**
 * Whether `filter[q]` (folded) matches the configuration's status: its title or its key, so
 * `labels` and `config` both find it.
 */
export function configMatches(q: string): boolean {
  return foldText(CONFIG_TITLE).includes(q) || CONFIG_KEY.includes(q);
}

/**
 * Whether `actor` manages the translation of the configuration's labels into `lang`:
 * `translation.manage` in a role whose scope restricts nothing but languages, `lang` among them
 * (`allowsAllIn`), as for a page design (`managesDesignIn`): the labels name every audience,
 * module type and variant, so a role limited to some of them manages none.
 */
export function managesConfigIn(actor: Actor, lang: string): boolean {
  return allowsAllIn(actor, 'translation.manage', lang);
}

/**
 * Whether `actor` may change the configuration (`checkConfigChange`, which locking it and
 * saving its working copy check again): `content.edit` in a role restricting nothing, and
 * `admin.roles`. An import and marking current write the labels' translation through those
 * actions.
 */
export function changesConfig(actor: Actor): boolean {
  try {
    checkConfigChange(actor);
    return true;
  } catch (error) {
    if (error instanceof ForbiddenError) return false;
    throw error;
  }
}

/**
 * Whether `actor` can carry the labels' translation into `lang` through an export and back: they
 * manage it (`managesConfigIn`) and may change the configuration (`changesConfig`), as the import
 * check requires. An export leaves the labels out for anyone else, so no unit waits at a provider
 * for an import that could never apply it.
 */
export function translatesConfigIn(actor: Actor, lang: string): boolean {
  return managesConfigIn(actor, lang) && changesConfig(actor);
}

/**
 * The configuration's labels in `lang` (#731), as a design's status: each unit at a provider
 * (`atProvider`, unit keys) is `at-provider`, else as `compareConfigWithRecord` finds it
 * (`missing` where a label has no version of its own in `lang`). `missing` while no label has
 * one (and some unit is due or none is at a provider), else `outdated` while any unit not at a
 * provider is due, else `at-provider` while any is, else `up-to-date`. Undefined for a
 * configuration without a label in the source language: nothing to translate.
 */
export function configTranslationStatus(input: {
  readonly config: ProjectConfig;
  readonly lang: string;
  readonly atProvider: ReadonlySet<string>;
}): TranslationStatus | undefined {
  const { config, lang, atProvider } = input;
  const compared = compareConfigWithRecord(config, lang);
  if (compared.length === 0) return undefined;
  const translated = hasConfigTranslation(config, lang);
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
  const record = configRecord(config, lang);
  return {
    kind: 'config',
    moduleId: CONFIG_KEY,
    lang,
    title: CONFIG_TITLE,
    state,
    blocks,
    outdatedBlocks,
    atProviderBlocks,
    sourceCommit: translated && record ? record.sourceCommit : null,
  };
}
