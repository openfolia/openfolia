/** Mark types in canonical order: printing opens them in this order and parsing sorts them back into it. */
export const MARK_ORDER = [
  'link',
  'term',
  'ui',
  'strong',
  'emphasis',
  'code',
  'sub',
  'sup',
] as const;
