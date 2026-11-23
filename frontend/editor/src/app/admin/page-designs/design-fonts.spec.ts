import type { Schema } from '../../api';
import {
  designFont,
  facesOf,
  type FontFile,
  fontFamilies,
  fontFiles,
  withFont,
} from './design-fonts';

const file = (
  n: string,
  family: string,
  weight: number,
  italic = false,
): FontFile => ({
  reference: `sha256:${n.repeat(64)}`,
  font: {
    format: 'ttf',
    family,
    subfamily: 'x',
    weight,
    italic,
    copyright: null,
    licence: null,
    licenceUrl: null,
  },
});

describe('design fonts (#555)', () => {
  it('takes the fonts of a list, nothing else', () => {
    const asset = (font: FontFile['font'] | null) =>
      ({
        type: 'Asset',
        id: 'a'.repeat(64),
        attributes: { reference: `sha256:${'a'.repeat(64)}`, font },
      }) as unknown as Schema<'AssetResource'>;
    expect(
      fontFiles([asset(null), asset(file('b', 'Sans', 400).font)]),
    ).toEqual([
      {
        reference: `sha256:${'a'.repeat(64)}`,
        font: file('b', 'Sans', 400).font,
      },
    ]);
  });

  it('groups files by family and picks each face by weight and slope', () => {
    const families = fontFamilies([
      file('1', 'Serif', 400),
      file('2', 'Sans', 700),
      file('3', 'Sans', 400),
      file('4', 'Sans', 500),
      file('5', 'Sans', 400, true),
      file('6', 'Sans', 800, true),
    ]);
    expect(families.map((f) => f.family)).toEqual(['Sans', 'Serif']);
    const sans = families[0]!;
    expect(sans.faces.regular?.reference).toBe(
      file('3', 'Sans', 400).reference,
    );
    expect(sans.faces.bold?.reference).toBe(file('2', 'Sans', 700).reference);
    expect(sans.faces.italic?.reference).toBe(file('5', 'Sans', 400).reference);
    expect(sans.faces.boldItalic?.reference).toBe(
      file('6', 'Sans', 800).reference,
    );
    expect(designFont(sans)).toEqual({
      family: 'Sans',
      regular: file('3', 'Sans', 400).reference,
      bold: file('2', 'Sans', 700).reference,
      italic: file('5', 'Sans', 400).reference,
      boldItalic: file('6', 'Sans', 800).reference,
    });
    expect(designFont(families[1]!)).toEqual({
      family: 'Serif',
      regular: file('1', 'Serif', 400).reference,
    });
  });

  it('gives a family of only a bold face that face as its regular one', () => {
    const [only] = fontFamilies([file('7', 'Display', 800)]);
    expect(designFont(only!)).toEqual({
      family: 'Display',
      regular: file('7', 'Display', 800).reference,
      bold: file('7', 'Display', 800).reference,
    });
    expect(facesOf(designFont(only!)!)).toEqual(['regular', 'bold']);
  });

  it('sets a role’s font and takes it out again, the licence confirmation kept', () => {
    const font = { family: 'Sans', regular: file('3', 'Sans', 400).reference };
    const fonts = { embeddingAllowed: true };
    const set = withFont(fonts, 'heading', font);
    expect(set).toEqual({ embeddingAllowed: true, heading: font });
    expect(withFont(set, 'heading', undefined)).toEqual({
      embeddingAllowed: true,
    });
  });
});
