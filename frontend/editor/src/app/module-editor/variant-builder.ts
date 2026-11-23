import {
  type Condition,
  formatCondition,
  isCondition,
  parseCondition,
} from '@openfolia/content-model/core';

// The variant picker's condition builder (screen 8): groups of "attribute is one of …" (enum
// attributes) and "version ≥ …" (version attributes), each negatable, combined with all or any.
// A condition of that shape maps to a builder and back; any other stays text only. Nothing here
// knows an attribute by name: they come from `GET /variants`.

/** A variant attribute as `GET /variants` lists it. */
export interface VariantAttributeInfo {
  readonly id: string;
  readonly label: string;
  readonly kind: 'enum' | 'version';
  /**
   * An enum attribute's values, in the configured order; none for a version attribute. An
   * archived value stays valid where content uses it, but is no longer offered (#91).
   */
  readonly values: readonly {
    readonly id: string;
    readonly label: string;
    readonly archived?: boolean;
  }[];
}

/** A version comparison; `=` is numeric equality (`in` with one value). */
export type CompareOp = '>=' | '>' | '<=' | '<' | '=';

export const COMPARE_OPS: readonly CompareOp[] = ['>=', '>', '<=', '<', '='];

export interface Comparison {
  readonly cmp: CompareOp;
  /** A dotted version; may be empty or unfinished while typed. */
  readonly value: string;
}

/** One attribute's group. An enum attribute uses `values`, a version attribute `comparisons`. */
export interface BuilderGroup {
  /** "is not": the group holds when its test does not. */
  readonly negate: boolean;
  /** Any of these values (configured IDs). */
  readonly values: readonly string[];
  /** All of these comparisons (a range: `>= 2.3` and `< 3`). */
  readonly comparisons: readonly Comparison[];
}

export interface Builder {
  /** How the groups combine: every group must hold, or one is enough. */
  readonly combine: 'all' | 'any';
  /** By attribute ID; a group with nothing chosen is left out of the condition. */
  readonly groups: Readonly<Record<string, BuilderGroup>>;
}

/** The longest condition the API takes. */
export const MAX_CONDITION_LENGTH = 1000;

const VERSION = /^\d+(?:\.\d+)*$/;

export const EMPTY_GROUP: BuilderGroup = {
  negate: false,
  values: [],
  comparisons: [],
};

export function emptyBuilder(combine: 'all' | 'any' = 'all'): Builder {
  return { combine, groups: {} };
}

export function groupOf(builder: Builder, attr: string): BuilderGroup {
  return builder.groups[attr] ?? EMPTY_GROUP;
}

/** Whether a version is one the content model takes (`2`, `2.3`, `2.3.1`). */
export function isVersion(value: string): boolean {
  return VERSION.test(value.trim());
}

/** A group's test without its negation, or null when nothing in it is chosen yet. */
function groupTest(
  attribute: VariantAttributeInfo,
  group: BuilderGroup,
): Condition | null {
  if (attribute.kind === 'enum') {
    // In the configured order, so the text does not depend on the order of the clicks.
    const values = attribute.values
      .map((v) => v.id)
      .filter((id) => group.values.includes(id));
    return values.length > 0 ? { op: 'in', attr: attribute.id, values } : null;
  }
  const tests = group.comparisons
    .filter((c) => c.value.trim() !== '')
    .map((c): Condition =>
      c.cmp === '='
        ? { op: 'in', attr: attribute.id, values: [c.value.trim()] }
        : {
            op: 'cmp',
            attr: attribute.id,
            cmp: c.cmp,
            value: c.value.trim(),
          },
    );
  if (tests.length === 0) return null;
  return tests.length === 1
    ? (tests[0] as Condition)
    : { op: 'all', of: tests };
}

/**
 * The builder as a condition, the attributes in their configured order; null when nothing is
 * chosen. A version not finished yet goes in as typed: `isCondition` tells it apart.
 */
export function toCondition(
  builder: Builder,
  attributes: readonly VariantAttributeInfo[],
): Condition | null {
  const parts: Condition[] = [];
  for (const attribute of attributes) {
    const group = builder.groups[attribute.id];
    if (!group) continue;
    const test = groupTest(attribute, group);
    if (!test) continue;
    parts.push(group.negate ? { op: 'not', of: test } : test);
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] as Condition;
  return { op: builder.combine, of: parts };
}

/** The builder as the AsciiDoc condition text; empty when nothing is chosen. */
export function toText(
  builder: Builder,
  attributes: readonly VariantAttributeInfo[],
): string {
  const condition = toCondition(builder, attributes);
  return condition ? formatCondition(condition) : '';
}

/** One attribute's test, read from a part of the condition; null when it is no such test. */
function readPart(
  part: Condition,
  attributes: ReadonlyMap<string, VariantAttributeInfo>,
): { attr: string; group: BuilderGroup } | null {
  const negate = part.op === 'not';
  const test = part.op === 'not' ? part.of : part;
  const simple = test.op === 'all' ? test.of : [test];
  const attr =
    simple[0] && (simple[0].op === 'in' || simple[0].op === 'cmp')
      ? simple[0].attr
      : null;
  const attribute = attr ? attributes.get(attr) : undefined;
  if (!attribute) return null;
  if (attribute.kind === 'enum') {
    // One `in` with known values.
    if (test.op !== 'in') return null;
    const known = new Set(attribute.values.map((v) => v.id));
    if (!test.values.every((v) => known.has(v))) return null;
    return {
      attr: attribute.id,
      group: { negate, values: [...new Set(test.values)], comparisons: [] },
    };
  }
  // A version: comparisons on this one attribute, all of which must hold.
  const comparisons: Comparison[] = [];
  for (const s of simple) {
    if (s.op === 'cmp' && s.attr === attribute.id)
      comparisons.push({ cmp: s.cmp, value: s.value });
    else if (s.op === 'in' && s.attr === attribute.id && s.values.length === 1)
      comparisons.push({ cmp: '=', value: s.values[0] as string });
    else return null;
  }
  return { attr: attribute.id, group: { negate, values: [], comparisons } };
}

/**
 * A condition as a builder, or null when the builder cannot show it (a nested mix, an attribute
 * or value the configuration does not hold, an attribute tested twice in a way one group cannot
 * say). With one group or none, the way groups combine is `combine`.
 */
export function fromCondition(
  condition: Condition | null,
  attributes: readonly VariantAttributeInfo[],
  combine: 'all' | 'any' = 'all',
): Builder | null {
  if (!condition) return emptyBuilder(combine);
  const byId = new Map(attributes.map((a) => [a.id, a]));
  const top =
    condition.op === 'all' || condition.op === 'any' ? condition.op : null;
  // `software >= 2 && software < 3` is one group too.
  const whole = readPart(condition, byId);
  if (whole) return { combine, groups: { [whole.attr]: whole.group } };
  if (!top) return null;
  const groups: Record<string, BuilderGroup> = {};
  for (const part of (condition as { of: Condition[] }).of) {
    const read = readPart(part, byId);
    if (!read) return null;
    const there = groups[read.attr];
    if (!there) {
      groups[read.attr] = read.group;
      continue;
    }
    // Two comparisons on one version, both required: one range.
    const attribute = byId.get(read.attr);
    if (
      top !== 'all' ||
      attribute?.kind !== 'version' ||
      there.negate ||
      read.group.negate
    )
      return null;
    groups[read.attr] = {
      ...there,
      comparisons: [...there.comparisons, ...read.group.comparisons],
    };
  }
  return { combine: Object.keys(groups).length > 1 ? top : combine, groups };
}

/** What a typed condition is. */
export type ParsedText =
  | { readonly kind: 'empty' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'condition'; readonly condition: Condition }
  /** It reads, but the content model would not keep it (a version that is not one). */
  | { readonly kind: 'invalid'; readonly condition: Condition };

export function parseText(text: string): ParsedText {
  if (text.trim() === '') return { kind: 'empty' };
  if (text.length > MAX_CONDITION_LENGTH) return { kind: 'unreadable' };
  let condition: Condition;
  try {
    condition = parseCondition(text);
  } catch {
    return { kind: 'unreadable' };
  }
  return isCondition(condition)
    ? { kind: 'condition', condition }
    : { kind: 'invalid', condition };
}

/** A name the configuration does not hold, found in a condition (to say which). */
export interface UnknownName {
  readonly issue:
    | 'unknown-variant-attribute'
    | 'unknown-variant-value'
    | 'version-compare-on-enum'
    | 'invalid-version-value';
  readonly attribute: string;
  readonly value: string;
}

/**
 * What in a condition the attributes of `GET /variants` do not hold, as the API's
 * `unknown-variant` issues name it, and the versions that are not versions. The API decides
 * whether a condition is refused; this only names the parts.
 */
export function unknownNames(
  condition: Condition,
  attributes: readonly VariantAttributeInfo[],
): UnknownName[] {
  const byId = new Map(attributes.map((a) => [a.id, a]));
  const found: UnknownName[] = [];
  const visit = (c: Condition): void => {
    switch (c.op) {
      case 'all':
      case 'any':
        c.of.forEach(visit);
        return;
      case 'not':
        visit(c.of);
        return;
      case 'in':
      case 'cmp': {
        const attribute = byId.get(c.attr);
        const values = c.op === 'in' ? c.values : [c.value];
        if (!attribute) {
          found.push({
            issue: 'unknown-variant-attribute',
            attribute: c.attr,
            value: '',
          });
        } else if (attribute.kind === 'enum' && c.op === 'cmp') {
          found.push({
            issue: 'version-compare-on-enum',
            attribute: attribute.label,
            value: '',
          });
        } else if (attribute.kind === 'enum') {
          for (const v of values)
            if (!attribute.values.some((o) => o.id === v))
              found.push({
                issue: 'unknown-variant-value',
                attribute: attribute.label,
                value: v,
              });
        } else {
          for (const v of values)
            if (!isVersion(v))
              found.push({
                issue: 'invalid-version-value',
                attribute: attribute.label,
                value: v,
              });
        }
      }
    }
  };
  visit(condition);
  return found;
}

/** Changes to a builder (each returns a new one). */
export function toggleValue(
  builder: Builder,
  attr: string,
  value: string,
  on: boolean,
): Builder {
  const group = groupOf(builder, attr);
  const values = on
    ? [...new Set([...group.values, value])]
    : group.values.filter((v) => v !== value);
  return withGroup(builder, attr, { ...group, values });
}

export function setNegate(
  builder: Builder,
  attr: string,
  negate: boolean,
): Builder {
  return withGroup(builder, attr, { ...groupOf(builder, attr), negate });
}

export function setComparison(
  builder: Builder,
  attr: string,
  index: number,
  comparison: Comparison,
): Builder {
  const group = groupOf(builder, attr);
  const comparisons = [...group.comparisons];
  comparisons[index] = comparison;
  return withGroup(builder, attr, { ...group, comparisons });
}

export function addComparison(builder: Builder, attr: string): Builder {
  const group = groupOf(builder, attr);
  // The second of a range is usually its upper end.
  const cmp: CompareOp = group.comparisons.length === 0 ? '>=' : '<';
  return withGroup(builder, attr, {
    ...group,
    comparisons: [...group.comparisons, { cmp, value: '' }],
  });
}

export function removeComparison(
  builder: Builder,
  attr: string,
  index: number,
): Builder {
  const group = groupOf(builder, attr);
  return withGroup(builder, attr, {
    ...group,
    comparisons: group.comparisons.filter((_, i) => i !== index),
  });
}

function withGroup(
  builder: Builder,
  attr: string,
  group: BuilderGroup,
): Builder {
  return { ...builder, groups: { ...builder.groups, [attr]: group } };
}
