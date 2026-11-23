import type { Schema } from '../../api';
import type { PageDesign } from './design-model';

/** A font file of the media library, as `GET /assets?filter[type]=font` lists it (#555). */
export interface FontFile {
  /** `sha256:<hash>`, what a design names. */
  readonly reference: string;
  readonly font: Schema<'AssetFont'>;
}

/** The faces a design's font family names (`DesignFont` without its family). */
export const FACES = ['regular', 'bold', 'italic', 'boldItalic'] as const;
export type Face = (typeof FACES)[number];

/** A family of uploaded fonts and the file it takes for each face it has. */
export interface FontFamily {
  readonly family: string;
  readonly faces: Partial<Record<Face, FontFile>>;
}

export type DesignFont = NonNullable<PageDesign['fonts']['body']>;
export type FontRole = 'body' | 'heading';

/** The fonts of a list (`AssetResource`s), those with font facts. */
export function fontFiles(
  assets: readonly Schema<'AssetResource'>[],
): FontFile[] {
  return assets.flatMap((a) =>
    a.attributes.font
      ? [{ reference: a.attributes.reference, font: a.attributes.font }]
      : [],
  );
}

/** Bold is 600 and up, as the PDF's weights go (headings print at 600). */
const isBold = (f: FontFile) => f.font.weight >= 600;

/**
 * The file for `face` among `files` of one family: the upright or italic ones of its weight
 * (regular below 600, bold from 600), the closest to 400 or 700; none when the family has no
 * such file. A family with only bold or italic files still gets a regular face, the closest.
 */
function faceOf(files: readonly FontFile[], face: Face): FontFile | undefined {
  const italic = face === 'italic' || face === 'boldItalic';
  const bold = face === 'bold' || face === 'boldItalic';
  const target = bold ? 700 : 400;
  const closest = (from: readonly FontFile[]) =>
    [...from].sort(
      (a, b) =>
        Math.abs(a.font.weight - target) - Math.abs(b.font.weight - target) ||
        (a.reference < b.reference ? -1 : 1),
    )[0];
  const exact = files.filter(
    (f) => f.font.italic === italic && isBold(f) === bold,
  );
  if (exact.length > 0) return closest(exact);
  if (face !== 'regular') return undefined;
  return closest(files.filter((f) => !f.font.italic)) ?? closest(files);
}

/** The families of `files`, by name, each with its faces. */
export function fontFamilies(files: readonly FontFile[]): FontFamily[] {
  const byFamily = new Map<string, FontFile[]>();
  for (const file of files) {
    const list = byFamily.get(file.font.family) ?? [];
    if (!list.some((f) => f.reference === file.reference)) list.push(file);
    byFamily.set(file.font.family, list);
  }
  return [...byFamily.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([family, list]) => {
      const faces: Partial<Record<Face, FontFile>> = {};
      for (const face of FACES) {
        const file = faceOf(list, face);
        if (file) faces[face] = file;
      }
      return { family, faces };
    });
}

/** What a design names for `family`: its name and the file of each face it has. */
export function designFont(family: FontFamily): DesignFont | undefined {
  const regular = family.faces.regular;
  if (!regular) return undefined;
  return {
    family: family.family,
    regular: regular.reference,
    ...(family.faces.bold && { bold: family.faces.bold.reference }),
    ...(family.faces.italic && { italic: family.faces.italic.reference }),
    ...(family.faces.boldItalic && {
      boldItalic: family.faces.boldItalic.reference,
    }),
  };
}

/** `fonts` with `role` set to `font`, or taken out (the standard font) for `undefined`. */
export function withFont(
  fonts: PageDesign['fonts'],
  role: FontRole,
  font: DesignFont | undefined,
): PageDesign['fonts'] {
  const next = { ...fonts };
  if (font) next[role] = font;
  else delete next[role];
  return next;
}

/** The faces a design's font names, in order. */
export function facesOf(font: DesignFont): Face[] {
  return FACES.filter((face) => font[face] !== undefined);
}
