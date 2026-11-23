/** The longest module ID the content model takes. */
export const MODULE_ID_MAX = 100;
/** A module ID: a lowercase slug (`battery-charging`). */
export const MODULE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FOLD: Readonly<Record<string, string>> = {
  ä: 'ae',
  ö: 'oe',
  ü: 'ue',
  ß: 'ss',
  æ: 'ae',
  ø: 'o',
  å: 'a',
  œ: 'oe',
};

/**
 * A module ID made from a title: lower case, accents dropped (umlauts spelled out), anything else
 * a hyphen, at most `MODULE_ID_MAX` characters. Empty when the title has no letter or digit a
 * slug can keep.
 */
export function moduleIdOf(title: string): string {
  const folded = title
    .toLowerCase()
    .replace(/[äöüßæøåœ]/g, (c) => FOLD[c] ?? c)
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  return folded
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, MODULE_ID_MAX)
    .replace(/^-+|-+$/g, '');
}
