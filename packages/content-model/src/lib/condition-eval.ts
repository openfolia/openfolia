import type { Condition } from './condition.js';

// Conditions evaluated for a variant (`evaluateCondition`), without a schema: `variant.ts`
// re-exports them with `VariantValues`, and `@openfolia/content-model/core` has them for a screen.

/** Compares dotted versions numerically; missing parts count as 0, so "2.3" equals "2.3.0". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export interface EvaluateOptions {
  /** Attributes compared as versions (`in` then means numeric equality). */
  versionAttributes?: ReadonlySet<string>;
  /** Called for each attribute the condition uses but the variant does not set. */
  onMissing?: (attr: string) => void;
}

/**
 * Whether a condition holds for a variant. A test on an attribute the
 * variant does not set is unknown, and unknown propagates (three-valued
 * logic: `not unknown` is unknown, `any` is true if some term is true,
 * `all` is false if some term is false). An unknown result counts as
 * false, so content is never included because an attribute is missing,
 * not even through `not`.
 */
export function evaluateCondition(
  condition: Condition,
  variant: Readonly<Record<string, string>>,
  options: EvaluateOptions = {},
): boolean {
  return evaluate(condition, variant, options) === true;
}

/** true, false, or undefined for unknown. */
function evaluate(
  condition: Condition,
  variant: Readonly<Record<string, string>>,
  options: EvaluateOptions,
): boolean | undefined {
  const value = (attr: string): string | undefined => {
    const v = variant[attr];
    if (v === undefined) options.onMissing?.(attr);
    return v;
  };
  switch (condition.op) {
    case 'all': {
      // Evaluate every term so all missing attributes get reported.
      const terms = condition.of.map((c) => evaluate(c, variant, options));
      if (terms.includes(false)) return false;
      return terms.includes(undefined) ? undefined : true;
    }
    case 'any': {
      const terms = condition.of.map((c) => evaluate(c, variant, options));
      if (terms.includes(true)) return true;
      return terms.includes(undefined) ? undefined : false;
    }
    case 'not': {
      const term = evaluate(condition.of, variant, options);
      return term === undefined ? undefined : !term;
    }
    case 'in': {
      const actual = value(condition.attr);
      if (actual === undefined) return undefined;
      return options.versionAttributes?.has(condition.attr)
        ? condition.values.some((v) => compareVersions(actual, v) === 0)
        : condition.values.includes(actual);
    }
    case 'cmp': {
      const actual = value(condition.attr);
      if (actual === undefined) return undefined;
      const order = compareVersions(actual, condition.value);
      switch (condition.cmp) {
        case '<':
          return order < 0;
        case '<=':
          return order <= 0;
        case '>':
          return order > 0;
        case '>=':
          return order >= 0;
      }
    }
  }
}
