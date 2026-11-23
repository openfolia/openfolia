import {
  type LocalizedText,
  printableText,
} from '@openfolia/content-model/core';

import type { Schema } from '../api';
import type { ShownConfig } from '../i18n';
import { conditionText, diffText, type Segment } from './review-diff';

type ModuleAttributes = Schema<'ModuleResource'>['attributes'];
type ManualAttributes = Schema<'ManualResource'>['attributes'];
/** The configuration with its labels in the interface language (`labelsInUi`). */
type Config = ShownConfig;

/**
 * A title as compared (#731): one text as it is, one per language as `en: …, de: …` in the order
 * of their languages, so a change to one language's version shows as one.
 */
export function comparedTitle(title: LocalizedText): string {
  const printed = printableText(title);
  return typeof printed === 'string'
    ? printed
    : Object.entries(printed)
        .map(([lang, text]) => `${lang}: ${text}`)
        .join(', ');
}

/** One changed field: its name (a translation key) and its value before and after, marked. */
export interface FieldDiff {
  readonly field: string;
  /** The old value, what was taken away marked as deleted; empty for none. */
  readonly before: readonly Segment[];
  /** The new value, what was added marked as inserted; empty for none. */
  readonly after: readonly Segment[];
  /** The deprecation (#266): a side that has one shows the Deprecated badge before its text. */
  readonly deprecation?: true;
}

type Deprecation = Schema<'Deprecation'>;

/** A deprecation as one line: the reason, then what replaces it. */
const deprecationText = (d: Deprecation | undefined): string =>
  d ? (d.replacedBy ? `${d.reason} → ${d.replacedBy}` : d.reason) : '';

/** The deprecation compared (#266): none on a side counts as empty. */
function deprecationField(
  before: Deprecation | undefined,
  after: Deprecation | undefined,
): FieldDiff | null {
  const field = textField(
    'editor.review.meta.field.deprecated',
    deprecationText(before),
    deprecationText(after),
  );
  return field && { ...field, deprecation: true };
}

/** A text compared word by word, each side with its own marks. */
function textField(field: string, before = '', after = ''): FieldDiff | null {
  if (before === after) return null;
  const segments = diffText(before, after);
  return {
    field,
    before: segments.filter((s) => s.op !== 'ins'),
    after: segments.filter((s) => s.op !== 'del'),
  };
}

/** A list compared value by value (labels shown, IDs compared). */
function listField(
  field: string,
  before: readonly { id: string; label: string }[],
  after: readonly { id: string; label: string }[],
): FieldDiff | null {
  const b = new Set(before.map((v) => v.id));
  const a = new Set(after.map((v) => v.id));
  if (b.size === a.size && [...b].every((id) => a.has(id))) return null;
  const side = (
    values: readonly { id: string; label: string }[],
    other: ReadonlySet<string>,
    op: 'ins' | 'del',
  ): Segment[] =>
    values.flatMap((v, i) => [
      ...(i > 0 ? [{ op: 'same' as const, text: ', ' }] : []),
      { op: other.has(v.id) ? ('same' as const) : op, text: v.label },
    ]);
  return {
    field,
    before: side(before, a, 'del'),
    after: side(after, b, 'ins'),
  };
}

const labelOf = (
  options: readonly { id: string; label: string }[] | undefined,
  id: string | undefined,
): string => (id ? (options?.find((o) => o.id === id)?.label ?? id) : '');

function facetValues(
  facets: Readonly<Record<string, readonly string[]>> | undefined,
  config: Config | null,
): { id: string; label: string }[] {
  return Object.entries(facets ?? {}).flatMap(([facet, values]) => {
    const f = config?.facets.find((x) => x.id === facet);
    return values.map((v) => ({
      id: `${facet}:${v}`,
      label: `${f?.label ?? facet}: ${labelOf(f?.values, v)}`,
    }));
  });
}

/**
 * A module's details that differ (title, type, audience, facets, keywords), with the values by
 * their configured labels. A side that is not there (added, removed) counts as empty.
 */
export function moduleFields(
  before: ModuleAttributes | null,
  after: ModuleAttributes | null,
  config: Config | null,
): FieldDiff[] {
  if (!before || !after) return [];
  const keywords = (m: ModuleAttributes) =>
    (m.keywords ?? []).map((k) => ({ id: k.toLowerCase(), label: k }));
  return [
    textField('editor.review.meta.field.title', before.title, after.title),
    textField(
      'editor.review.meta.field.type',
      labelOf(config?.moduleTypes, before.moduleType),
      labelOf(config?.moduleTypes, after.moduleType),
    ),
    textField(
      'editor.review.meta.field.audience',
      labelOf(config?.audiences, before.audience),
      labelOf(config?.audiences, after.audience),
    ),
    listField(
      'editor.review.meta.field.facets',
      facetValues(before.facets, config),
      facetValues(after.facets, config),
    ),
    listField(
      'editor.review.meta.field.keywords',
      keywords(before),
      keywords(after),
    ),
    deprecationField(before.deprecated, after.deprecated),
  ].filter((f): f is FieldDiff => f !== null);
}

type Variant = Readonly<Record<string, string>>;

function variantLabel(v: Variant, config: Config | null): string {
  return Object.entries(v)
    .map(([attr, value]) => {
      const a = config?.variantAttributes.find((x) => x.id === attr);
      const shown = a?.kind === 'enum' ? labelOf(a.values, value) : value;
      return `${a?.label ?? attr}: ${shown}`;
    })
    .join(', ');
}

type TextAttribute = ManualAttributes['textAttributes'][string];

function attributeText(value: TextAttribute): string {
  if (typeof value === 'string') return value;
  return value
    .map((v) => (v.when ? `${v.value} (${conditionText(v.when)})` : v.value))
    .join('; ');
}

/**
 * A manual's details that differ (title, audience, variants, text attributes), with labels from
 * the configuration. The outline is compared on its own.
 */
export function manualFields(
  before: ManualAttributes | null,
  after: ManualAttributes | null,
  config: Config | null,
): FieldDiff[] {
  if (!before || !after) return [];
  const variants = (m: ManualAttributes) =>
    m.variants.map((v) => ({
      id: JSON.stringify(Object.entries(v).sort()),
      label: variantLabel(v, config),
    }));
  const attributes = (m: ManualAttributes) =>
    Object.entries(m.textAttributes ?? {}).map(([id, value]) => {
      const label =
        config?.textAttributes.find((t) => t.id === id)?.label ?? id;
      const text = `${label}: ${attributeText(value)}`;
      return { id: text, label: text };
    });
  return [
    textField(
      'editor.review.meta.field.title',
      comparedTitle(before.title),
      comparedTitle(after.title),
    ),
    textField(
      'editor.review.meta.field.audience',
      labelOf(config?.audiences, before.audience),
      labelOf(config?.audiences, after.audience),
    ),
    listField(
      'editor.review.meta.field.variants',
      variants(before),
      variants(after),
    ),
    listField(
      'editor.review.meta.field.attributes',
      attributes(before),
      attributes(after),
    ),
    deprecationField(before.deprecated, after.deprecated),
  ].filter((f): f is FieldDiff => f !== null);
}
