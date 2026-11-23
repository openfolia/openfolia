import type { Schema } from '../api';
import type { ProjectConfig } from '../content/browser-model';
import type { OutlineRow } from './manual-outline';
import type { VariantValues } from './manual-variants';

export type Condition = Schema<'Condition'>;
type DraftManifest = Schema<'DraftManifest'>;
export type Issue = Schema<'Issue'>;

/** A text attribute's value as the manifest holds it: one value, or values each for some variants. */
export type AttributeValue = DraftManifest['attributes'][string];

/** One value of a text attribute; without `when` it holds for every variant (that the ones before leave). */
export interface AttributeOption {
  readonly value: string;
  readonly when?: Condition | undefined;
}

/** The manual's cover images (#394): its own (`default`) and each variant's (`variants`). */
export type CoverImages = NonNullable<DraftManifest['coverImage']>;
/** One cover image: the file and its alternative text, one for every language or one per language. */
export type CoverImage = NonNullable<CoverImages['default']>;
/** Whose cover image: the manual's (every variant without its own) or one variant's. */
export type CoverTarget = 'manual' | VariantValues;

/** What a manual is built for, beside its outline: the manifest's settings. */
export interface ManualSettings {
  readonly audience?: string | undefined;
  readonly variants: readonly VariantValues[];
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  /** The manual's own page design (#589, the manifest's `design`); none: the project's default. */
  readonly design?: string | undefined;
  /** The manual's cover images (#394); none: the page design's. */
  readonly coverImage?: CoverImages | undefined;
}

/** A change to the settings: only the fields named change (`audience: undefined`, `design: undefined` or `coverImage: undefined` clears it). */
export type SettingsPatch = Partial<ManualSettings>;

/** Whether two combinations set the same attributes to the same values (the order aside). */
export function sameVariant(a: VariantValues, b: VariantValues): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
}

/** The index of another combination equal to `values` (ignoring the one at `except`), or -1. */
export function duplicateOf(
  variants: readonly VariantValues[],
  values: VariantValues,
  except = -1,
): number {
  return variants.findIndex((v, i) => i !== except && sameVariant(v, values));
}

/** A combination with only the attributes given a value (an empty value leaves one out). */
export function cleanVariant(
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const v = value?.trim() ?? '';
      return v === '' ? [] : [[key, v]];
    }),
  );
}

/** Puts a removed combination back where it was (at the end when that is past the list). */
export function restoreVariant(
  variants: readonly VariantValues[],
  values: VariantValues,
  index: number,
): VariantValues[] {
  if (duplicateOf(variants, values) >= 0) return [...variants];
  const at = Math.min(index, variants.length);
  return [...variants.slice(0, at), values, ...variants.slice(at)];
}

/** A text attribute's values as a list (none when it is not set). */
export function toOptions(
  value: AttributeValue | undefined,
): AttributeOption[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [{ value }];
  return value.map((o) =>
    o.when ? { value: o.value, when: o.when } : { value: o.value },
  );
}

/**
 * The manifest's form of a text attribute's values: none is not set (undefined), one for every
 * variant is a plain value, else the list (the first that holds wins).
 */
export function fromOptions(
  options: readonly AttributeOption[],
): AttributeValue | undefined {
  if (options.length === 0) return undefined;
  const [only] = options;
  if (options.length === 1 && only && !only.when) return only.value;
  return options.map((o) =>
    o.when ? { value: o.value, when: o.when } : { value: o.value },
  );
}

/** The attributes with `id` set to `value` (removed when undefined). */
export function withAttribute(
  attributes: Readonly<Record<string, AttributeValue>>,
  id: string,
  value: AttributeValue | undefined,
): Record<string, AttributeValue> {
  const next = { ...attributes };
  if (value === undefined) delete next[id];
  else next[id] = value;
  return next;
}

/**
 * The text attributes the panel lists: every configured one (set or not), then any the manifest
 * sets that is not configured (an issue the panel shows, with a way to remove it).
 */
export function attributeRows(
  config: ProjectConfig,
  attributes: Readonly<Record<string, AttributeValue>>,
): { id: string; label: string; configured: boolean }[] {
  const configured = config.textAttributes.map((a) => ({
    id: a.id,
    label: a.label,
    configured: true,
  }));
  const known = new Set(configured.map((a) => a.id));
  const unknown = Object.keys(attributes)
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: id, configured: false }));
  return [...configured, ...unknown];
}

/** The row `id` with its condition set (`null`: it applies to every variant). */
export function setRowCondition(
  rows: readonly OutlineRow[],
  id: string,
  when: Condition | null,
): OutlineRow[] {
  return rows.map((row) => {
    if (row.id !== id) return row;
    if (when) return { ...row, when };
    const rest: OutlineRow = { ...row };
    delete (rest as { when?: Condition }).when;
    return rest;
  });
}

/** Where the content model's issues are about: the manifest's field each one names. */
export type IssueField =
  | { readonly kind: 'audience' }
  | { readonly kind: 'variants' }
  | { readonly kind: 'variant'; readonly index: number }
  | { readonly kind: 'attribute'; readonly id: string }
  /** The cover images (#394): a variant it does not build, an alternative text's language. */
  | { readonly kind: 'cover' };

const VARIANT_AT = /^variant (\d+)$/;

/** The issues about `field`, as the working copy's checks name them (`at`, `code`). */
export function issuesFor(
  issues: readonly Issue[],
  field: IssueField,
): Issue[] {
  return issues.filter((issue) => {
    switch (field.kind) {
      case 'audience':
        return issue.code === 'unknown-audience' && issue.at === undefined;
      case 'variants':
        return issue.code === 'inconsistent-variants';
      case 'variant': {
        const n = VARIANT_AT.exec(issue.at ?? '')?.[1];
        return n !== undefined && Number(n) === field.index + 1;
      }
      case 'attribute':
        return issue.at === field.id && ATTRIBUTE_CODES.has(issue.code);
      case 'cover':
        return (issue.at ?? '').startsWith('coverImage.');
    }
  });
}

/** Codes of the issues a text attribute (`at`: its ID) can have. */
const ATTRIBUTE_CODES = new Set([
  'unknown-text-attribute',
  'unknown-variant-attribute',
  'unknown-variant-value',
  'version-compare-on-enum',
  'invalid-version-value',
]);

/** Codes of the issues a row's condition can have (`at`: the module's ID or the chapter's title). */
const CONDITION_CODES = new Set([
  'unknown-variant-attribute',
  'unknown-variant-value',
  'version-compare-on-enum',
  'invalid-version-value',
]);

/** The issues about a row's condition (none for a row without one). */
export function rowIssues(issues: readonly Issue[], row: OutlineRow): Issue[] {
  if (!row.when) return [];
  return issues.filter(
    (issue) => issue.at === row.ref && CONDITION_CODES.has(issue.code),
  );
}

/**
 * The values with the one at `index` given `when` (null: every variant). A value given a condition
 * moves before the first value for every variant above it, which would otherwise always win.
 */
export function withCondition(
  options: readonly AttributeOption[],
  index: number,
  when: Condition | null,
): AttributeOption[] {
  const option = options[index];
  if (!option) return [...options];
  const changed: AttributeOption = when
    ? { value: option.value, when }
    : { value: option.value };
  const rest = options.filter((_, i) => i !== index);
  let at = index;
  if (when) {
    const fallback = options.findIndex((o, i) => i < index && !o.when);
    if (fallback >= 0) at = fallback;
  }
  return [...rest.slice(0, at), changed, ...rest.slice(at)];
}

/** The cover image `target` has of its own (#394), if any. */
export function coverOf(
  covers: CoverImages | undefined,
  target: CoverTarget,
): CoverImage | undefined {
  if (!covers) return undefined;
  if (target === 'manual') return covers.default;
  const own = covers.variants.find((v) => sameVariant(v.variant, target));
  return own && { asset: own.asset, alt: own.alt };
}

/**
 * The cover images with `target`'s set to `image` (undefined: taken away); undefined when none is
 * left, so the manifest names none. A variant's keeps its place in the list, a new one goes last.
 */
export function withCover(
  covers: CoverImages | undefined,
  target: CoverTarget,
  image: CoverImage | undefined,
): CoverImages | undefined {
  let own = covers?.default;
  let variants = [...(covers?.variants ?? [])];
  if (target === 'manual') {
    own = image;
  } else {
    const at = variants.findIndex((v) => sameVariant(v.variant, target));
    const entry = image && {
      variant: { ...target },
      asset: image.asset,
      alt: image.alt,
    };
    if (at < 0) {
      if (entry) variants.push(entry);
    } else if (entry) {
      variants[at] = entry;
    } else {
      variants = variants.filter((_, i) => i !== at);
    }
  }
  if (!own && variants.length === 0) return undefined;
  return { ...(own ? { default: own } : {}), variants };
}

/**
 * The variants' own cover images that are never shown (`unknown-cover-variant`): for a variant
 * the manual does not build, or one with an image before it. By their place in `variants`.
 */
export function unshownCovers(
  covers: CoverImages | undefined,
  built: readonly VariantValues[],
): number[] {
  const out: number[] = [];
  (covers?.variants ?? []).forEach((entry, i, all) => {
    const isBuilt = built.some((v) => sameVariant(v, entry.variant));
    const before = all
      .slice(0, i)
      .some((other) => sameVariant(other.variant, entry.variant));
    if (!isBuilt || before) out.push(i);
  });
  return out;
}

/** The cover images without the variant entry at `index`; undefined when none is left. */
export function withoutCoverAt(
  covers: CoverImages | undefined,
  index: number,
): CoverImages | undefined {
  if (!covers) return undefined;
  const variants = covers.variants.filter((_, i) => i !== index);
  if (!covers.default && variants.length === 0) return undefined;
  return { ...covers, variants };
}

/**
 * The cover images after a variant's values changed from `from` to `to` (undefined: removed): its
 * own image follows it, or goes with it.
 */
export function moveCoverVariant(
  covers: CoverImages | undefined,
  from: VariantValues,
  to: VariantValues | undefined,
): CoverImages | undefined {
  const image = coverOf(covers, from);
  if (!covers || !image) return covers;
  const without = withCover(covers, from, undefined);
  return to ? withCover(without, to, image) : without;
}

/**
 * A cover image's alternative text in `lang`: its own, or the one text for every language; empty
 * when it has none in that language.
 */
export function altIn(
  alt: CoverImage['alt'] | undefined,
  lang: string,
): string {
  if (alt === undefined) return '';
  if (typeof alt === 'string') return alt;
  return alt[lang] ?? '';
}

/**
 * The alternative text with `lang`'s set to `text` (empty: taken away); undefined when no language
 * has one left. One text for every language stays one when the source language's is changed; a
 * target language's of its own makes it per language: the source's and that one, the other
 * targets falling back to the source's (and reported as untranslated) rather than keeping a copy
 * of the old text.
 */
export function withAlt(
  alt: CoverImage['alt'] | undefined,
  lang: string,
  text: string,
  source: string,
): CoverImage['alt'] | undefined {
  const value = text.trim().replace(/\s+/g, ' ');
  if (typeof alt === 'string') {
    if (lang === source) return value === '' ? undefined : value;
    return value === '' ? alt : { [source]: alt, [lang]: value };
  }
  const per: Record<string, string> = { ...alt };
  if (value === '') delete per[lang];
  else per[lang] = value;
  return Object.keys(per).length === 0 ? undefined : per;
}
