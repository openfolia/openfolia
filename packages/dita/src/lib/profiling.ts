import {
  type Condition,
  DITA_FILTER_ATTRIBUTES,
  type DitaMapping,
  type DitaProfiling,
  type ProjectConfig,
  type VariantValues,
} from '@openfolia/content-model';
import type { XmlElement } from '@openfolia/xml';
import { attr, elements, nameOf } from './elements.js';
import type { DitaReport, ReportPlace } from './report.js';

const VERSION = /^\d+(?:\.\d+)*$/;

/** One group of a filter attribute's value: its name (the attribute's, or the group's) and tokens. */
interface Group {
  readonly name: string;
  readonly values: readonly string[];
}

/**
 * The groups of a filter attribute's value (DITA 1.3, 2.4.3.2): the
 * ungrouped tokens as one group named after the attribute, and each
 * `name(a b)` as a group of its own. Empty groups are dropped.
 */
export function groupsOf(attribute: string, value: string): Group[] {
  const groups: Group[] = [];
  const loose: string[] = [];
  const pattern = /([^\s()]+)\s*\(([^()]*)\)|([^\s()]+)/g;
  for (const match of value.matchAll(pattern)) {
    if (match[1] !== undefined) {
      const values = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
      if (values.length > 0) groups.push({ name: match[1], values });
    } else if (match[3] !== undefined) {
      loose.push(match[3]);
    }
  }
  if (loose.length > 0) groups.unshift({ name: attribute, values: loose });
  return groups;
}

/** What a profiling name maps to, with the defaults filled in; undefined for nothing. */
export type Target =
  | {
      readonly kind: 'variant';
      readonly attribute: ProjectConfig['variantAttributes'][number];
      readonly values: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'audience';
      readonly values: Readonly<Record<string, string>>;
    };

/**
 * The profiling mapping read against the configuration: a name the mapping
 * lists, to what it says (when that is configured); else a name that is a
 * configured variant attribute's ID, to it with the same values; else
 * `audience`, to the audience levels of the same IDs.
 */
export class Profiling {
  constructor(
    private readonly mapping: DitaMapping,
    private readonly config: ProjectConfig,
  ) {}

  target(name: string): Target | undefined {
    const own: DitaProfiling | undefined = Object.hasOwn(
      this.mapping.profiling,
      name,
    )
      ? this.mapping.profiling[name]
      : undefined;
    if (own) {
      if ('audience' in own) {
        const values = Object.fromEntries(
          Object.entries(own.audience).filter(([, id]) =>
            this.config.audiences.some((a) => a.id === id),
          ),
        );
        return { kind: 'audience', values };
      }
      const attribute = this.config.variantAttributes.find(
        (a) => a.id === own.variantAttribute,
      );
      return (
        attribute && { kind: 'variant', attribute, values: own.values ?? {} }
      );
    }
    const attribute = this.config.variantAttributes.find((a) => a.id === name);
    if (attribute) return { kind: 'variant', attribute, values: {} };
    if (name === 'audience') {
      return {
        kind: 'audience',
        values: Object.fromEntries(
          this.config.audiences.map((a) => [a.id, a.id]),
        ),
      };
    }
    return undefined;
  }

  /** The variant value a DITA value is, if it is one. */
  variantValue(
    target: Extract<Target, { kind: 'variant' }>,
    token: string,
  ): string | undefined {
    const value = Object.hasOwn(target.values, token)
      ? (target.values[token] as string)
      : token;
    const { attribute } = target;
    if (attribute.kind === 'enum') {
      return attribute.values.some((v) => v.id === value) ? value : undefined;
    }
    return VERSION.test(value) ? value : undefined;
  }

  /** The DITA names (attributes or groups) whose values become `attribute`'s. */
  namesOf(attribute: string): string[] {
    const names = Object.keys(this.mapping.profiling).filter((name) => {
      const t = this.mapping.profiling[name];
      return (
        t !== undefined &&
        'variantAttribute' in t &&
        t.variantAttribute === attribute
      );
    });
    if (!Object.hasOwn(this.mapping.profiling, attribute))
      names.push(attribute);
    return names;
  }
}

/** The filter attributes an element carries, with their values. */
export function filterAttributes(element: XmlElement): [string, string][] {
  const found: [string, string][] = [];
  for (const name of DITA_FILTER_ATTRIBUTES) {
    const value = attr(element, name);
    if (value !== undefined && value.trim() !== '') found.push([name, value]);
  }
  return found;
}

/** What an element's filter attributes say: the condition its content holds under, and the audience levels it names. */
export interface Profile {
  readonly when?: Condition;
  readonly audiences: readonly string[];
}

/** The most distinct conditions one element's profiling attributes make (a condition is written out with every copy). */
export const MAX_ELEMENT_CONDITIONS = 32;

/**
 * An element's filter attributes as a condition (DITA 1.3, 2.4.3.2): an
 * element is excluded when any attribute (any group) excludes it, and a
 * group excludes it only when all its values are excluded, so each group is
 * an `in` of its values and the groups are `all` of them. A value that maps
 * to nothing is reported and left out (so content applies whatever it was);
 * `audience` values that map to audience levels are given back for a module
 * or manual to take.
 */
export function profileOf(
  element: XmlElement,
  profiling: Profiling,
  report: DitaReport,
  place: ReportPlace,
): Profile {
  const conditions: Condition[] = [];
  const seen = new Set<string>();
  const audiences: string[] = [];
  for (const [attribute, value] of filterAttributes(element)) {
    for (const group of groupsOf(attribute, value)) {
      const target = profiling.target(group.name);
      if (!target) {
        report.add(
          'unmapped-profiling',
          place,
          `${group.name}="${group.values.join(' ')}" maps to no variant attribute or audience; the content is imported for every variant. Map "${group.name}" in "dita.profiling".`,
        );
        continue;
      }
      if (target.kind === 'audience') {
        for (const v of group.values) {
          const level = Object.hasOwn(target.values, v)
            ? target.values[v]
            : undefined;
          if (level === undefined) {
            report.add(
              'unmapped-profiling',
              place,
              `The audience "${v}" maps to no audience level; it is left out.`,
            );
          } else if (!audiences.includes(level)) {
            audiences.push(level);
          }
        }
        continue;
      }
      const values: string[] = [];
      for (const v of group.values) {
        const mapped = profiling.variantValue(target, v);
        if (mapped === undefined) {
          report.add(
            'unmapped-profiling',
            place,
            `${group.name}="${v}" is no value of the variant attribute "${target.attribute.id}"; it is left out of the condition.`,
          );
        } else if (!values.includes(mapped)) {
          values.push(mapped);
        }
      }
      if (values.length > 0) {
        const condition: Condition = {
          op: 'in',
          attr: target.attribute.id,
          values: [...values].sort(),
        };
        // The same group twice says nothing more; past the bound, the rest is left out.
        const key = JSON.stringify(condition);
        if (seen.has(key)) continue;
        if (conditions.length >= MAX_ELEMENT_CONDITIONS) {
          report.add(
            'condition-limit',
            place,
            `More than ${MAX_ELEMENT_CONDITIONS} conditions on one element; the rest is left out, so it is imported for more variants than it says.`,
          );
          continue;
        }
        seen.add(key);
        conditions.push(condition);
      }
    }
  }
  const when: Condition | undefined =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : { op: 'all', of: conditions };
  return { ...(when && { when }), audiences };
}

/** The least restricted of `levels`, by the configuration's order. */
export function leastRestricted(
  levels: readonly string[],
  config: ProjectConfig,
): string | undefined {
  return config.audiences.find((a) => levels.includes(a.id))?.id;
}

type Action = 'include' | 'exclude' | 'passthrough' | 'flag';

/** A DITAVAL file, read (DITA 1.3, 3.4: `<val>`, `<prop>`). */
export interface Ditaval {
  readonly path: string;
  /** `att` → `val` (or `''` for the attribute's default) → action; `''` → `''` the global default. */
  readonly props: ReadonlyMap<string, ReadonlyMap<string, Action>>;
}

export function readDitaval(
  path: string,
  root: XmlElement,
  report: DitaReport,
): Ditaval {
  const props = new Map<string, Map<string, Action>>();
  for (const element of elements(root)) {
    const name = nameOf(element);
    if (name === 'revprop') {
      report.add(
        'ditaval-action',
        { source: path, kind: 'revprop' },
        'Revision flagging (<revprop>) has no counterpart; it is left out.',
      );
      continue;
    }
    if (name !== 'prop') continue;
    const action = attr(element, 'action') as Action | undefined;
    if (
      action !== 'include' &&
      action !== 'exclude' &&
      action !== 'passthrough' &&
      action !== 'flag'
    ) {
      continue;
    }
    if (action === 'flag' || action === 'passthrough') {
      report.add(
        'ditaval-action',
        { source: path, kind: 'prop' },
        `The action "${action}" has no counterpart: the content is included without it.`,
      );
    }
    const att = attr(element, 'att') ?? '';
    const val = attr(element, 'val') ?? '';
    let byValue = props.get(att);
    if (!byValue) props.set(att, (byValue = new Map()));
    if (!byValue.has(val)) byValue.set(val, action);
  }
  return { path, props };
}

/** Whether a DITA value is excluded by the DITAVAL (a group's own rule over its attribute's, then the defaults). */
function excluded(ditaval: Ditaval, name: string, value: string): boolean {
  const action =
    ditaval.props.get(name)?.get(value) ??
    ditaval.props.get(name)?.get('') ??
    ditaval.props.get('')?.get('') ??
    'include';
  return action === 'exclude';
}

/**
 * The variant a DITAVAL file describes: per variant attribute the DITA
 * names map to, the one value it leaves included. A DITAVAL saying nothing
 * of an attribute leaves it unset; one leaving several values (or none)
 * included is reported and leaves it unset too (a manual's variant holds one
 * value per attribute).
 */
export function variantOf(
  ditaval: Ditaval,
  profiling: Profiling,
  config: ProjectConfig,
  report: DitaReport,
): VariantValues {
  const variant: VariantValues = {};
  for (const attribute of config.variantAttributes) {
    // Only the DITA attributes this file decides: one it does not mention includes everything.
    const names = profiling
      .namesOf(attribute.id)
      .filter((n) => ditaval.props.has(n));
    if (names.length === 0) continue;
    const target = profiling.target(names[0] as string);
    if (!target || target.kind !== 'variant') continue;
    let included: string[];
    if (attribute.kind === 'enum') {
      included = attribute.values
        .map((v) => v.id)
        .filter((id) =>
          // Included when no attribute the file decides excludes it.
          names.every((name) => {
            const t = profiling.target(name);
            if (!t || t.kind !== 'variant') return true;
            const ditaValues = Object.keys(t.values).filter(
              (k) => t.values[k] === id,
            );
            if (!Object.hasOwn(t.values, id)) ditaValues.push(id);
            return ditaValues.some((dv) => !excluded(ditaval, name, dv));
          }),
        );
    } else {
      included = [];
      for (const name of names) {
        for (const [val, action] of ditaval.props.get(name) ?? []) {
          if (action === 'exclude' || val === '') continue;
          const t = profiling.target(name);
          const mapped =
            t && t.kind === 'variant'
              ? profiling.variantValue(t, val)
              : undefined;
          if (mapped !== undefined && !included.includes(mapped))
            included.push(mapped);
        }
      }
    }
    if (included.length === 1) {
      variant[attribute.id] = included[0] as string;
    } else {
      report.add(
        'ditaval-variant',
        { source: ditaval.path, kind: 'val' },
        included.length === 0
          ? `It excludes every value of "${attribute.id}"; the variant leaves "${attribute.id}" unset.`
          : `It leaves ${included.length} values of "${attribute.id}" included (${included.join(', ')}); a variant holds one, so "${attribute.id}" is left unset.`,
      );
    }
  }
  return variant;
}
