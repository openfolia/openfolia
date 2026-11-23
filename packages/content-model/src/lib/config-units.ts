import { type LocalizedText, sourceTextOf, textIn } from './localized-text.js';
import type { TranslatableUnit } from './translatable-units.js';
import type { VariantValues } from './variant.js';

/** The lists of the configuration whose items have a label (#731), in the order units come. */
export const LABELLED_LISTS = [
  'moduleTypes',
  'audiences',
  'facets',
  'variantAttributes',
  'textAttributes',
  'safetySymbols',
  'calloutStyles',
] as const;
export type LabelledList = (typeof LABELLED_LISTS)[number];

interface Labelled {
  readonly id: string;
  readonly label: LocalizedText;
}

/** The parts of a configuration its labels live in, as any reader (the API's JSON too) holds them. */
export type LabelledConfig = {
  readonly [K in LabelledList]?: readonly (Labelled & {
    readonly values?: readonly Labelled[];
  })[];
};

/** One configured label with its unit key (`ConfigUnitKey`). */
export interface ConfigText {
  readonly key: string;
  readonly text: LocalizedText;
}

/**
 * The configuration's labels with their unit keys, in its order: each list's items
 * (`moduleTypes.<id>`), a facet's or an enum variant attribute's values right after it
 * (`facets.<id>.<value>`).
 */
export function configTexts(config: LabelledConfig): ConfigText[] {
  const texts: ConfigText[] = [];
  for (const list of LABELLED_LISTS) {
    for (const item of config[list] ?? []) {
      texts.push({ key: `${list}.${item.id}`, text: item.label });
      for (const value of item.values ?? []) {
        texts.push({
          key: `${list}.${item.id}.${value.id}`,
          text: value.label,
        });
      }
    }
  }
  return texts;
}

/** A translatable unit of the configuration (#731): a label in the source language, as a title. */
export interface ConfigUnit extends TranslatableUnit {
  readonly kind: 'section';
}

/**
 * The configuration's translatable units (#731), in the source language `source`: each label
 * (`configTexts`) as a section's `title` part, one text run of plain text. A label without
 * source-language text has none.
 */
export function configUnits(
  config: LabelledConfig,
  source: string,
): ConfigUnit[] {
  return configTexts(config).flatMap(({ key, text }) => {
    const value = sourceTextOf(text, source);
    if (value === undefined) return [];
    return [
      {
        blockId: key,
        kind: 'section' as const,
        parts: [
          { field: 'title' as const, content: [{ type: 'text', text: value }] },
        ],
      },
    ];
  });
}

type LabelsIn<T> = T extends readonly (infer U)[]
  ? LabelsIn<U>[]
  : T extends object
    ? {
        [K in keyof T]: K extends 'label'
          ? string
          : K extends 'values'
            ? LabelsIn<T[K]>
            : T[K];
      }
    : T;

/**
 * A configuration with every label as the one text to show in a language (`labelsIn`): the
 * shape of `C` with each item's `label` (and its values') a string.
 */
export type ConfigLabelsIn<C> = {
  [K in keyof C]: K extends LabelledList ? LabelsIn<C[K]> : C[K];
};

/**
 * `config` with every label in `lang` (#731, `textIn`: its own version there, else the source
 * language's), for a reader that shows labels and never edits them: the editor's screens, the
 * portal, a renderer. The rest of the configuration as it is.
 */
export function labelsIn<
  C extends LabelledConfig & { languages: { source: string } },
>(config: C, lang: string): ConfigLabelsIn<C> {
  const source = config.languages.source;
  const out: Record<string, unknown> = { ...config };
  for (const list of LABELLED_LISTS) {
    const items = config[list];
    if (items === undefined) continue;
    out[list] = items.map((item) => ({
      ...item,
      label: textIn(item.label, lang, source),
      ...(item.values !== undefined && {
        values: item.values.map((value) => ({
          ...value,
          label: textIn(value.label, lang, source),
        })),
      }),
    }));
  }
  return out as ConfigLabelsIn<C>;
}

/**
 * The label in `lang` of an item of a configured list (`textIn`), by its ID; undefined for an ID
 * the list does not have.
 */
export function labelOf(
  config: LabelledConfig & { languages: { source: string } },
  list: LabelledList,
  id: string,
  lang: string,
): string | undefined {
  const item = config[list]?.find((i) => i.id === id);
  return item && textIn(item.label, lang, config.languages.source);
}

/**
 * A variant as people name it in `lang` (#731), from the configured labels: each attribute the
 * configuration has, in its order, an enum's value by its label (else its ID), a version as the
 * attribute's label and the version, joined with ` · `: `Large · Software 2.3`.
 */
export function variantLabel(
  variant: VariantValues,
  config: VariantLabelConfig,
  lang: string,
): string {
  const source = config.languages.source;
  const parts: string[] = [];
  for (const attribute of config.variantAttributes) {
    const value = variant[attribute.id];
    if (value === undefined) continue;
    if (attribute.kind === 'version') {
      parts.push(`${textIn(attribute.label, lang, source)} ${value}`);
    } else {
      const found = attribute.values?.find((v) => v.id === value);
      parts.push(found ? textIn(found.label, lang, source) : value);
    }
  }
  return parts.join(' · ');
}

/** What `variantLabel` reads of a configuration: `ProjectConfig`, or the API's JSON of it. */
export interface VariantLabelConfig {
  readonly languages: { readonly source: string };
  readonly variantAttributes: readonly {
    readonly id: string;
    readonly label: LocalizedText;
    readonly kind: string;
    readonly values?: readonly Labelled[];
  }[];
}
