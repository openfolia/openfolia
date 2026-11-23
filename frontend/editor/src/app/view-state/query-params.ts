/**
 * One query parameter of a screen's view state: how its values in the address are read and
 * written. `parse` gets every occurrence of the name (a repeated parameter has several) and
 * answers the value, or undefined when they are not valid (the default applies and the parameter
 * is dropped from the address). `format` answers what goes into the address; the default is
 * always left out.
 */
export interface QueryParam<T> {
  readonly parse: (values: readonly string[]) => T | undefined;
  readonly format: (value: T) => readonly string[];
  readonly fallback: T;
  readonly equal: (a: T, b: T) => boolean;
  /**
   * Text typed (a search): a run of changes is one history entry. The first change after anything
   * else adds an entry; the next ones, while nothing else changed the address, replace it.
   */
  readonly typing: boolean;
}

const single = (values: readonly string[]): string | undefined =>
  values.length === 1 ? values[0] : undefined;

export const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Text, trimmed and capped (`max` characters); empty is the default. A run of typing is one entry. */
export function textParam(
  options: { readonly max?: number } = {},
): QueryParam<string> {
  const max = options.max ?? 200;
  return {
    parse: (values) => {
      const value = single(values)?.trim();
      return value !== undefined && value.length <= max ? value : undefined;
    },
    format: (value) => (value ? [value] : []),
    fallback: '',
    equal: (a, b) => a === b,
    typing: true,
  };
}

/** A whole number from `min` to `max`; `fallback` (left out of the address) otherwise. */
export function intParam(
  fallback: number,
  options: {
    readonly min?: number;
    readonly max?: number;
    /** Only these values (page sizes, say). */
    readonly only?: readonly number[];
  } = {},
): QueryParam<number> {
  const { min = 1, max = 1_000_000, only } = options;
  return {
    parse: (values) => {
      const raw = single(values);
      if (raw === undefined || !/^\d{1,7}$/.test(raw)) return undefined;
      const n = Number(raw);
      return n >= min && n <= max && (!only || only.includes(n))
        ? n
        : undefined;
    },
    format: (value) => [String(value)],
    fallback,
    equal: (a, b) => a === b,
    typing: false,
  };
}

/**
 * One of these words. Without `fallback`, undefined when absent or anything else; with it, that
 * word (left out of the address).
 */
export function oneOfParam<T extends string>(
  choices: readonly T[],
): QueryParam<T | undefined>;
export function oneOfParam<T extends string>(
  choices: readonly T[],
  fallback: T,
): QueryParam<T>;
export function oneOfParam<T extends string>(
  choices: readonly T[],
  fallback?: T,
): QueryParam<T | undefined> {
  return {
    parse: (values) => {
      const raw = single(values);
      return choices.find((c) => c === raw);
    },
    format: (value) => (value === undefined ? [] : [value]),
    fallback,
    equal: (a, b) => a === b,
    typing: false,
  };
}

/**
 * One value that passes `valid` (a pattern, a type guard): an ID, a key. Undefined (left out)
 * when absent or not valid.
 */
export function idParam(
  valid: RegExp | ((value: string) => boolean),
): QueryParam<string | undefined> {
  const test =
    typeof valid === 'function' ? valid : (v: string) => valid.test(v);
  return {
    parse: (values) => {
      const raw = single(values);
      return raw !== undefined && test(raw) ? raw : undefined;
    },
    format: (value) => (value === undefined ? [] : [value]),
    fallback: undefined,
    equal: (a, b) => a === b,
    typing: false,
  };
}

/**
 * A repeated parameter (`?keyword=a&keyword=b`): every value that passes `valid`, in order,
 * without repeats, at most `max`; the empty list is the default. Values that do not pass are
 * dropped (the others stay).
 */
export function listParam(
  valid: RegExp | ((value: string) => boolean),
  options: { readonly max?: number } = {},
): QueryParam<readonly string[]> {
  const max = options.max ?? 32;
  const test =
    typeof valid === 'function' ? valid : (v: string) => valid.test(v);
  return {
    parse: (values) => {
      const kept = [...new Set(values.filter(test))].slice(0, max);
      return kept.length === values.length ? values : kept;
    },
    format: (value) => value,
    fallback: [],
    equal: sameList,
    typing: false,
  };
}
