import type { ConfigTranslationRecord, ProjectConfig } from './config.js';
import {
  configTexts,
  configUnits,
  LABELLED_LISTS,
  type LabelledList,
} from './config-units.js';
import { type LocalizedText, sourceTextOf } from './localized-text.js';
import {
  compareTexts,
  hasTextIn,
  keptRecord,
  markTextsCurrent,
  recordIn,
  type TextUnitState,
} from './text-record.js';
import { sourceHash, type SourceHash } from './translation.js';

/** The source hash of each of the configuration's units (its labels), by unit key, in order. */
export function configSourceHashes(
  config: ProjectConfig,
): Map<string, SourceHash> {
  return new Map(
    configUnits(config, config.languages.source).map((unit) => [
      unit.blockId,
      sourceHash(unit),
    ]),
  );
}

/** The configuration's record for `lang`, if it has one. */
export function configRecord(
  config: Pick<ProjectConfig, 'translations'>,
  lang: string,
): ConfigTranslationRecord | undefined {
  return recordIn(config.translations, lang) as
    ConfigTranslationRecord | undefined;
}

/**
 * Each of the configuration's units (its labels, #731) in `lang`: `missing` where the label has
 * no version of its own in `lang`, `outdated` where it has but the record
 * (`config.translations[lang]`) does not name the unit with the hash its source text has now,
 * else `up-to-date`.
 */
export function compareConfigWithRecord(
  config: ProjectConfig,
  lang: string,
): TextUnitState[] {
  const source = config.languages.source;
  return compareTexts(
    configUnits(config, source),
    configTexts(config),
    configRecord(config, lang),
    lang,
    source,
  );
}

/** Whether some label has a version of its own in `lang`. */
export function hasConfigTranslation(
  config: ProjectConfig,
  lang: string,
): boolean {
  return hasTextIn(configTexts(config), lang, config.languages.source);
}

/** One imported unit of the configuration: its translated text and the hash it was exported with. */
export interface ConfigUnitImport {
  readonly text: string;
  readonly hash: string;
}

/**
 * `config` with imported labels in `lang` (`units` by unit key) put in, and its record for `lang`
 * updated, as `mergeManifestTranslation` does for a manifest: each label keeps every language's
 * version it has, one for every language becomes the source language's; the record names, per
 * unit put in, the hash it was exported with and `sourceCommit`, its other units as they were. A
 * unit of a label the configuration no longer has, or one without source text, is left out. The
 * texts are taken as given: plain text, checked by the caller.
 */
export function mergeConfigTranslation(
  config: ProjectConfig,
  lang: string,
  sourceCommit: string,
  units: ReadonlyMap<string, ConfigUnitImport>,
): ProjectConfig {
  const source = config.languages.source;
  const imported = new Map<string, string>();
  const translate = (key: string, text: LocalizedText): LocalizedText => {
    const unit = units.get(key);
    if (!unit || sourceTextOf(text, source) === undefined) return text;
    imported.set(key, unit.hash);
    return {
      ...(typeof text === 'string' ? { [source]: text } : text),
      [lang]: unit.text,
    };
  };
  const next = mapLabels(config, translate);
  if (imported.size === 0) return config;
  const blocks = keptRecord(configTexts(next), configRecord(config, lang));
  for (const [key, hash] of imported) blocks[key] = hash;
  return {
    ...next,
    translations: { ...config.translations, [lang]: { sourceCommit, blocks } },
  };
}

/**
 * `config` with its record for `lang` taking the source's current hash for every label with a
 * version in `lang`, without changing any text (marking a translation current). Also how many
 * units the record now names as current.
 */
export function markConfigCurrent(
  config: ProjectConfig,
  lang: string,
  sourceCommit: string,
): { readonly config: ProjectConfig; readonly units: number } {
  const source = config.languages.source;
  const { record, units } = markTextsCurrent(
    configUnits(config, source),
    configTexts(config),
    configRecord(config, lang),
    lang,
    source,
    sourceCommit,
  );
  return {
    config: {
      ...config,
      translations: { ...config.translations, [lang]: record },
    },
    units,
  };
}

/** `config` with each label (and value label) passed through `map` with its unit key. */
export function mapLabels(
  config: ProjectConfig,
  map: (key: string, text: LocalizedText) => LocalizedText,
): ProjectConfig {
  const out = { ...config } as Record<LabelledList, unknown> & ProjectConfig;
  for (const list of LABELLED_LISTS) {
    const items = config[list] as
      | readonly {
          id: string;
          label: LocalizedText;
          values?: readonly { id: string; label: LocalizedText }[];
        }[]
      | undefined;
    if (items === undefined) continue;
    (out as Record<string, unknown>)[list] = items.map((item) => ({
      ...item,
      label: map(`${list}.${item.id}`, item.label),
      ...(item.values !== undefined && {
        values: item.values.map((value) => ({
          ...value,
          label: map(`${list}.${item.id}.${value.id}`, value.label),
        })),
      }),
    }));
  }
  return out;
}
