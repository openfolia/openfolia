import { z } from 'zod';
import { ConfigKey } from './ids.js';
import { variantSlug } from './variant-slug.js';

export { variantSlug } from './variant-slug.js';
// Schema-free, so `@openfolia/content-model/core` has them too.
export {
  compareVersions,
  evaluateCondition,
  type EvaluateOptions,
} from './condition-eval.js';

/**
 * One concrete variant: a value for each variant attribute, e.g.
 * { model: "l-400", software: "2.3", market: "eu" }. Enum attributes take a
 * configured value id; version attributes take a dotted version.
 */
export const VariantValues = z.record(ConfigKey, z.string().min(1));
export type VariantValues = z.infer<typeof VariantValues>;

/**
 * The variant a slug names (the inverse of `variantSlug`), or `undefined`
 * when the text is not a slug: an empty text, a part without `=`, an empty
 * or repeated key, a key that is not a config key, an empty value or a
 * malformed `~` escape.
 */
export function parseVariantSlug(slug: string): VariantValues | undefined {
  if (slug.length === 0) return undefined;
  const values: Record<string, string> = {};
  for (const part of slug.split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) return undefined;
    const key = part.slice(0, at);
    const value = decodeSlugValue(part.slice(at + 1));
    if (value === undefined || value.length === 0) return undefined;
    if (Object.hasOwn(values, key)) return undefined;
    values[key] = value;
  }
  const parsed = VariantValues.safeParse(values);
  // Only the canonical spelling names a variant: one slug per variant.
  return parsed.success && variantSlug(parsed.data) === slug
    ? parsed.data
    : undefined;
}

function decodeSlugValue(text: string): string | undefined {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch !== '~') {
      out += ch;
      continue;
    }
    const end = text.indexOf(';', i);
    const hex = end < 0 ? '' : text.slice(i + 1, end);
    if (!/^[0-9a-f]{1,6}$/.test(hex)) return undefined;
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) {
      return undefined;
    }
    out += String.fromCodePoint(point);
    i = end;
  }
  return out;
}
