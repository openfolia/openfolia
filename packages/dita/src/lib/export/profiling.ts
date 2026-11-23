import {
  type Condition,
  compareVersions,
  DITA_FILTER_ATTRIBUTES,
  type DitaMapping,
  evaluateCondition,
  type ProjectConfig,
  type VariantValues,
} from '@openfolia/content-model';
import { el, type El } from './xml.js';

/** The token written for a set of values no variant holds: no DITAVAL includes it. */
export const NO_VALUE = 'openfolia-none';

/** How a condition was written as profiling attributes. */
export interface ProfileAttributes {
  /** The filter attributes, in a fixed order: `product`, `platform`, …, `props` with its groups. */
  readonly attrs: ReadonlyArray<readonly [string, string]>;
  /**
   * `exact`: as the condition says, for every value; `shipped`: the same for
   * every variant the manual ships (a version compared, or a combination
   * profiling has no form for, written as the values the shipped variants
   * hold); `approximated`: the shipped variants it holds in, and more (no
   * form of filter attributes says exactly which).
   */
  readonly fidelity: 'exact' | 'shipped' | 'approximated';
}

/** Per variant attribute, the values a condition holds for (it holds when every attribute's value is among them). */
type Sets = Map<string, Set<string>>;

const FILTER = new Set<string>(DITA_FILTER_ATTRIBUTES);

/**
 * The DITA mapping (`dita` in `openfolia.yaml`, #432) read backwards (#433): which
 * filter attribute (or group in `@props`) a variant attribute's values are
 * written to and as which tokens, which attribute holds the audience levels,
 * and the DITAVAL file of each variant. A condition becomes filter
 * attributes: DITA excludes an element when every value of one of its
 * attributes (or groups) is excluded, so each attribute is an `in` of its
 * values and the attributes are `all` of them, which is exactly a product
 * of per-attribute value sets. A condition of that form is written as it
 * is; a version comparison is written as the shipped versions it holds for;
 * any other is written as the values of the variants it holds in, and only
 * when that is no product either, as more than it says (reported).
 */
export class ExportProfiling {
  private readonly mapping: DitaMapping['profiling'];
  private readonly versionAttributes: ReadonlySet<string>;
  /** Per version attribute, the versions the shipped variants hold. */
  private readonly shippedVersions = new Map<string, string[]>();

  constructor(
    private readonly config: ProjectConfig,
    private readonly shipped: readonly VariantValues[],
  ) {
    this.mapping = config.dita?.profiling ?? {};
    this.versionAttributes = new Set(
      config.variantAttributes
        .filter((a) => a.kind === 'version')
        .map((a) => a.id),
    );
    for (const attribute of this.versionAttributes) {
      const values = new Set<string>();
      for (const variant of shipped) {
        const value = variant[attribute];
        if (value !== undefined) values.add(value);
      }
      this.shippedVersions.set(attribute, [...values].sort(compareVersions));
    }
  }

  /** The DITA name (a filter attribute, or a group in `@props`) a variant attribute's values go to. */
  nameOf(attribute: string): string {
    for (const [name, target] of Object.entries(this.mapping)) {
      if ('variantAttribute' in target && target.variantAttribute === attribute)
        return name;
    }
    return attribute;
  }

  /** The DITA token of a variant attribute's value (the mapping's, else the value itself). */
  token(attribute: string, value: string): string {
    const name = this.nameOf(attribute);
    const target = Object.hasOwn(this.mapping, name)
      ? this.mapping[name]
      : undefined;
    if (target && 'variantAttribute' in target && target.values) {
      for (const [dita, ours] of Object.entries(target.values)) {
        if (ours === value) return dita;
      }
    }
    return value;
  }

  /** The filter attribute for an audience level, or undefined when none can say it. */
  audience(level: string): readonly [string, string] | undefined {
    for (const [name, target] of Object.entries(this.mapping)) {
      if (!('audience' in target)) continue;
      for (const [dita, ours] of Object.entries(target.audience)) {
        if (ours === level) return this.attribute(name, [dita]);
      }
      return undefined;
    }
    const claimed = Object.hasOwn(this.mapping, 'audience');
    return claimed ? undefined : this.attribute('audience', [level]);
  }

  /** A condition as filter attributes (see the class). */
  attributes(condition: Condition): ProfileAttributes {
    const enumerated = { value: false };
    let sets = this.sets(condition, enumerated);
    let fidelity: ProfileAttributes['fidelity'] = enumerated.value
      ? 'shipped'
      : 'exact';
    if (!sets) {
      const found = this.fromShipped(condition);
      sets = found.sets;
      fidelity = found.exact ? 'shipped' : 'approximated';
    }
    return { attrs: this.write(sets), fidelity };
  }

  /** The DITAVAL file of a variant: every variant attribute's values excluded but the variant's own. */
  ditaval(variant: VariantValues): El {
    const props: El[] = [];
    const seen = new Set<string>();
    for (const attribute of this.config.variantAttributes) {
      const name = this.nameOf(attribute.id);
      if (seen.has(name)) continue;
      seen.add(name);
      props.push(el('prop', { att: name, action: 'exclude' }));
      const value = variant[attribute.id];
      if (value !== undefined) {
        props.push(
          el('prop', {
            att: name,
            val: this.token(attribute.id, value),
            action: 'include',
          }),
        );
      }
    }
    return el('val', {}, props);
  }

  private sets(
    condition: Condition,
    enumerated: { value: boolean },
  ): Sets | undefined {
    switch (condition.op) {
      case 'in': {
        if (!this.versionAttributes.has(condition.attr)) {
          return new Map([[condition.attr, new Set(condition.values)]]);
        }
        // Equal versions are equal however they are written (`2.3`, `2.3.0`).
        const values = new Set(condition.values);
        for (const shipped of this.shippedVersions.get(condition.attr) ?? []) {
          if (condition.values.some((v) => compareVersions(shipped, v) === 0))
            values.add(shipped);
        }
        return new Map([[condition.attr, values]]);
      }
      case 'cmp': {
        enumerated.value = true;
        const holds = (this.shippedVersions.get(condition.attr) ?? []).filter(
          (v) =>
            evaluateCondition(
              condition,
              { [condition.attr]: v },
              {
                versionAttributes: this.versionAttributes,
              },
            ),
        );
        return new Map([[condition.attr, new Set(holds)]]);
      }
      case 'all': {
        const out: Sets = new Map();
        for (const part of condition.of) {
          const sets = this.sets(part, enumerated);
          if (!sets) return undefined;
          for (const [attribute, values] of sets) {
            const before = out.get(attribute);
            out.set(
              attribute,
              before
                ? new Set([...before].filter((v) => values.has(v)))
                : values,
            );
          }
        }
        return out;
      }
      case 'any': {
        let attribute: string | undefined;
        const union = new Set<string>();
        for (const part of condition.of) {
          const sets = this.sets(part, enumerated);
          if (!sets || sets.size !== 1) return undefined;
          const [[name, values]] = [...sets] as [[string, Set<string>]];
          if (attribute !== undefined && name !== attribute) return undefined;
          attribute = name;
          for (const v of values) union.add(v);
        }
        return attribute === undefined
          ? undefined
          : new Map([[attribute, union]]);
      }
      case 'not': {
        const sets = this.sets(condition.of, enumerated);
        if (!sets || sets.size !== 1) return undefined;
        const [[attribute, values]] = [...sets] as [[string, Set<string>]];
        const domain = this.domain(attribute);
        if (domain === undefined) return undefined;
        if (this.versionAttributes.has(attribute)) enumerated.value = true;
        return new Map([
          [attribute, new Set(domain.filter((v) => !values.has(v)))],
        ]);
      }
    }
  }

  /** An enum attribute's configured values, a version attribute's shipped ones; undefined for one not configured. */
  private domain(attribute: string): string[] | undefined {
    if (this.versionAttributes.has(attribute)) {
      return this.shippedVersions.get(attribute) ?? [];
    }
    const found = this.config.variantAttributes.find((a) => a.id === attribute);
    return found?.kind === 'enum' ? found.values.map((v) => v.id) : undefined;
  }

  /** The values of the shipped variants a condition holds in, per attribute it names; exact when they make the same set. */
  private fromShipped(condition: Condition): { sets: Sets; exact: boolean } {
    const names = new Set<string>();
    const collect = (c: Condition) => {
      if (c.op === 'in' || c.op === 'cmp') names.add(c.attr);
      else if (c.op === 'not') collect(c.of);
      else c.of.forEach(collect);
    };
    collect(condition);
    const options = { versionAttributes: this.versionAttributes };
    const holding = this.shipped.filter((v) =>
      evaluateCondition(condition, v, options),
    );
    const sets: Sets = new Map();
    for (const name of [...names].sort()) {
      const values = new Set<string>();
      for (const v of holding) {
        const value = v[name];
        if (value !== undefined) values.add(value);
      }
      sets.set(name, values);
    }
    const written = this.shipped.filter((v) =>
      [...sets].every(([name, values]) => {
        const value = v[name];
        return value !== undefined && values.has(value);
      }),
    );
    return { sets, exact: written.length === holding.length };
  }

  private attribute(
    name: string,
    tokens: readonly string[],
  ): readonly [string, string] {
    const value = tokens.join(' ');
    return FILTER.has(name) ? [name, value] : ['props', `${name}(${value})`];
  }

  /** Value sets as filter attributes: each attribute once, its groups after its own tokens. */
  private write(sets: Sets): ReadonlyArray<readonly [string, string]> {
    const byAttribute = new Map<string, string[]>();
    for (const attribute of [...sets.keys()].sort()) {
      const values = [...(sets.get(attribute) as Set<string>)];
      const tokens = [
        ...new Set(values.map((v) => this.token(attribute, v))),
      ].sort();
      const [name, value] = this.attribute(
        this.nameOf(attribute),
        tokens.length === 0 ? [NO_VALUE] : tokens,
      );
      const list = byAttribute.get(name) ?? [];
      list.push(value);
      byAttribute.set(name, list);
    }
    return DITA_FILTER_ATTRIBUTES.filter((n) => byAttribute.has(n)).map(
      (n) => [n, (byAttribute.get(n) as string[]).join(' ')] as const,
    );
  }
}
