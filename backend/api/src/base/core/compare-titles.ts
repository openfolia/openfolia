/**
 * Compares two titles as `a.localeCompare(b, undefined, { sensitivity:
 * 'base' })` does, with one collator made once: `localeCompare` with
 * options makes a collator on every call, which costs a list of thousands
 * seconds and memory outside the heap when it is sorted.
 */
export const compareTitles: (a: string, b: string) => number =
  new Intl.Collator(undefined, { sensitivity: 'base' }).compare;
