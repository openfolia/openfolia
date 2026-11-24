/**
 * The manual page's variant switch (#844): one choice per variant attribute that tells the
 * manual's variants apart (Body, Drive, Market…). Each value leads to the variant with this
 * one's other values and that value; when the manual has no such variant (not every
 * combination is published), to the variant with that value that keeps the most of the other
 * values, and the option names what else changes ("only as Electric").
 */

interface Variant {
  readonly values: Readonly<Record<string, string>>;
}

interface Attribute {
  readonly id: string;
  readonly label: string;
  readonly values: readonly { readonly id: string; readonly label: string }[];
}

/** Another attribute the option changes, and the value it changes to. */
export interface SwitchChange {
  readonly attribute: string;
  readonly attributeLabel: string;
  readonly valueLabel: string;
}

export interface SwitchOption<V extends Variant> {
  readonly value: string;
  readonly label: string;
  readonly target: V;
  readonly current: boolean;
  /** Empty when the option keeps every other value. */
  readonly changes: readonly SwitchChange[];
}

export interface VariantSwitch<V extends Variant> {
  readonly attribute: string;
  readonly label: string;
  readonly options: readonly SwitchOption<V>[];
}

/** The switch for `current`, one of `variants`; the attributes' labels and order from `attributes`. */
export function variantSwitches<V extends Variant>(
  variants: readonly V[],
  current: V,
  attributes: readonly Attribute[],
): VariantSwitch<V>[] {
  const configured = (id: string) => attributes.find((a) => a.id === id);
  const valueLabel = (attribute: string, value: string) =>
    configured(attribute)?.values.find((v) => v.id === value)?.label ?? value;
  const ids = [...new Set(variants.flatMap((v) => Object.keys(v.values)))];
  return ids
    .filter((a) => new Set(variants.map((v) => v.values[a])).size > 1)
    .map((attribute) => {
      const values = configured(attribute)?.values ?? [];
      const used = new Set(
        variants.map((v) => v.values[attribute]).filter((v) => v !== undefined),
      );
      // The configured order first, then values the configuration does not list.
      const order = [
        ...values.map((v) => v.id).filter((id) => used.has(id)),
        ...[...used].filter((id) => !values.some((v) => v.id === id)),
      ];
      return {
        attribute,
        label: configured(attribute)?.label ?? attribute,
        options: order.map((value) => {
          const target = closest(variants, current, attribute, value);
          const changes = ids
            .filter(
              (other) =>
                other !== attribute &&
                target.values[other] !== undefined &&
                target.values[other] !== current.values[other],
            )
            .map((other) => ({
              attribute: other,
              attributeLabel: configured(other)?.label ?? other,
              valueLabel: valueLabel(other, target.values[other] ?? ''),
            }));
          return {
            value,
            label: valueLabel(attribute, value),
            target,
            current: current.values[attribute] === value,
            changes,
          };
        }),
      };
    });
}

/** The variant with `attribute` = `value` that differs least from `current`; the manual's first on a tie. */
function closest<V extends Variant>(
  variants: readonly V[],
  current: V,
  attribute: string,
  value: string,
): V {
  let best: V | undefined;
  let bestDistance = Infinity;
  for (const candidate of variants) {
    if (candidate.values[attribute] !== value) continue;
    const keys = new Set([
      ...Object.keys(candidate.values),
      ...Object.keys(current.values),
    ]);
    keys.delete(attribute);
    const distance = [...keys].filter(
      (k) => candidate.values[k] !== current.values[k],
    ).length;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // `value` comes from the variants, so one always has it.
  return best as V;
}

/** The query a switch that changes other attributes adds to its link, read by the page it opens. */
export const SWITCHED_PARAM = 'switched';
export const CHANGED_PARAM = 'changed';

/** The option's link: the target's path, plus what it changed when it changes other attributes. */
export function switchHref(
  path: string,
  attribute: string,
  changes: readonly SwitchChange[],
): string {
  if (changes.length === 0) return path;
  const query = new URLSearchParams({
    [SWITCHED_PARAM]: attribute,
    [CHANGED_PARAM]: changes.map((c) => c.attribute).join(','),
  });
  return `${path}?${query}`;
}
