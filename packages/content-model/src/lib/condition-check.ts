import type { Condition } from './condition.js';

/** A configuration key: lowercase, starting with a letter, e.g. `product-line` (`ConfigKey`). */
export const CONFIG_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The longest configuration key. */
export const MAX_CONFIG_KEY_LENGTH = 64;

/** A dotted version, e.g. `2.3` or `2.3.1` (`Version`). */
export const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

const CMP_OPERATORS: ReadonlySet<unknown> = new Set(['<', '<=', '>', '>=']);

function isConfigKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_CONFIG_KEY_LENGTH &&
    CONFIG_KEY_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` is an array of at least `min` elements, each passing `test` (holes fail). */
function isArrayOf(
  value: unknown,
  min: number,
  test: (element: unknown) => boolean,
): boolean {
  if (!Array.isArray(value) || value.length < min) return false;
  for (let i = 0; i < value.length; i++) if (!test(value[i])) return false;
  return true;
}

/**
 * Whether `value` is a valid variant condition: what the `Condition` schema accepts, without the
 * schema (and zod), for code that only reads conditions. Like the schema, it allows keys of its
 * own beside the known ones. `condition-check.spec.ts` holds the two to the same answers.
 */
export function isCondition(value: unknown): value is Condition {
  if (!isRecord(value)) return false;
  switch (value['op']) {
    case 'all':
    case 'any':
      return isArrayOf(value['of'], 2, isCondition);
    case 'not':
      return isCondition(value['of']);
    case 'in':
      return (
        isConfigKey(value['attr']) &&
        isArrayOf(
          value['values'],
          1,
          (v) => typeof v === 'string' && v.length >= 1,
        )
      );
    case 'cmp':
      return (
        isConfigKey(value['attr']) &&
        CMP_OPERATORS.has(value['cmp']) &&
        typeof value['value'] === 'string' &&
        VERSION_PATTERN.test(value['value'])
      );
    default:
      return false;
  }
}
