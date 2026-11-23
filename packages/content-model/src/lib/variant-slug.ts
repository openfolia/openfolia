import type { VariantValues } from './variant.js';

/**
 * A stable name for a variant, safe in URLs, file names and HTTP headers:
 * `market=eu,model=l-400,software=2.3`. Keys are sorted. Value characters
 * other than letters, digits, `.` and `-` are written as `~` plus hex code
 * point (`~7e;`), so different variants never share a slug.
 */
export function variantSlug(variant: VariantValues): string {
  return Object.keys(variant)
    .sort()
    .map((key) => `${key}=${encodeSlugValue(variant[key] ?? '')}`)
    .join(',');
}

function encodeSlugValue(value: string): string {
  let out = '';
  for (const ch of value) {
    out += /[A-Za-z0-9.-]/.test(ch)
      ? ch
      : `~${(ch.codePointAt(0) ?? 0).toString(16)};`;
  }
  return out;
}
