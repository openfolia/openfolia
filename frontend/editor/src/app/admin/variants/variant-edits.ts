import type { LocalizedText } from '@openfolia/content-model/core';

import type { EnumAttribute, VariantAttribute } from '../settings/config-model';

// The edits the Variants tab makes to the variant attributes (#91): each takes the attributes as
// they are and gives the new list, leaving everything else as it was. Nothing here knows an
// attribute by name.

export type VariantValue = EnumAttribute['values'][number];

/** What is selected on the Variants tab: an attribute, or one value of an enum attribute. */
export interface VariantSelection {
  readonly attribute: string;
  readonly value?: string | undefined;
}

export function findAttribute(
  attributes: readonly VariantAttribute[],
  id: string | undefined,
): VariantAttribute | undefined {
  return id === undefined ? undefined : attributes.find((a) => a.id === id);
}

export function findValue(
  attributes: readonly VariantAttribute[],
  attribute: string | undefined,
  value: string | undefined,
): VariantValue | undefined {
  const a = findAttribute(attributes, attribute);
  return a?.kind === 'enum' && value !== undefined
    ? a.values.find((v) => v.id === value)
    : undefined;
}

/** `f` applied to the values of enum attribute `attribute`; the rest unchanged. */
function mapValues(
  attributes: readonly VariantAttribute[],
  attribute: string,
  f: (values: readonly VariantValue[]) => VariantValue[],
): VariantAttribute[] {
  return attributes.map((a) =>
    a.id === attribute && a.kind === 'enum' ? { ...a, values: f(a.values) } : a,
  );
}

export function renameAttribute(
  attributes: readonly VariantAttribute[],
  attribute: string,
  label: LocalizedText,
): VariantAttribute[] {
  return attributes.map((a) => (a.id === attribute ? { ...a, label } : a));
}

export function renameValue(
  attributes: readonly VariantAttribute[],
  attribute: string,
  value: string,
  label: LocalizedText,
): VariantAttribute[] {
  return mapValues(attributes, attribute, (vs) =>
    vs.map((v) => (v.id === value ? { ...v, label } : v)),
  );
}

/** Archives (content keeps it, pickers hide it) or restores a value. */
export function setArchived(
  attributes: readonly VariantAttribute[],
  attribute: string,
  value: string,
  archived: boolean,
): VariantAttribute[] {
  return mapValues(attributes, attribute, (vs) =>
    vs.map((v) => {
      if (v.id !== value) return v;
      return archived
        ? { id: v.id, label: v.label, archived: true }
        : { id: v.id, label: v.label };
    }),
  );
}

export function removeValue(
  attributes: readonly VariantAttribute[],
  attribute: string,
  value: string,
): VariantAttribute[] {
  return mapValues(attributes, attribute, (vs) =>
    vs.filter((v) => v.id !== value),
  );
}

export function removeAttribute(
  attributes: readonly VariantAttribute[],
  attribute: string,
): VariantAttribute[] {
  return attributes.filter((a) => a.id !== attribute);
}

export function addValue(
  attributes: readonly VariantAttribute[],
  attribute: string,
  value: VariantValue,
): VariantAttribute[] {
  return mapValues(attributes, attribute, (vs) => [...vs, value]);
}

export function addAttribute(
  attributes: readonly VariantAttribute[],
  attribute: VariantAttribute,
): VariantAttribute[] {
  return [...attributes, attribute];
}

/** The attributes in the order of `ids` (any not named keep their place at the end). */
export function orderAttributes(
  attributes: readonly VariantAttribute[],
  ids: readonly string[],
): VariantAttribute[] {
  return byIds(attributes, ids);
}

/** The values of `attribute` in the order of `ids`. */
export function orderValues(
  attributes: readonly VariantAttribute[],
  attribute: string,
  ids: readonly string[],
): VariantAttribute[] {
  return mapValues(attributes, attribute, (vs) => byIds(vs, ids));
}

function byIds<T extends { readonly id: string }>(
  items: readonly T[],
  ids: readonly string[],
): T[] {
  const rank = new Map(ids.map((id, i) => [id, i]));
  return [...items].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** The condition naming one value, for `GET /variants/matches` (IDs are configuration keys). */
export const valueCondition = (attribute: string, value: string): string =>
  `${attribute} in (${value})`;
