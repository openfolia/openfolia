import { readdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The default brand's assets (`src/brand/`): the owner's outlined masters, committed as they
 * are. The editor serves them and the PDF's title page embeds the mark, so each must be
 * self-contained: no script, no external reference, no text that needs a font. They carry no
 * provenance metadata either (content credentials name the tool that made a file; this repository
 * names no vendor): a re-import from the kit has to strip it again.
 */
const brandDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/brand',
);

/** The chunk types of a PNG, in order (compressed text chunks inflated into `text`). */
function pngChunks(png: Buffer): { type: string; text: string }[] {
  const out: { type: string; text: string }[] = [];
  for (let i = 8; i + 8 <= png.length;) {
    const length = png.readUInt32BE(i);
    const type = png.toString('latin1', i + 4, i + 8);
    const data = png.subarray(i + 8, i + 8 + length);
    let text = data.toString('latin1');
    if (type === 'zTXt') {
      text += inflateSync(data.subarray(data.indexOf(0) + 2)).toString(
        'latin1',
      );
    }
    out.push({ type, text });
    i += 12 + length;
  }
  return out;
}

/** The PNG images inside an ICO file. */
function icoImages(ico: Buffer): Buffer[] {
  const images: Buffer[] = [];
  for (let k = 0; k < ico.readUInt16LE(4); k++) {
    const size = ico.readUInt32LE(6 + 16 * k + 8);
    const offset = ico.readUInt32LE(6 + 16 * k + 12);
    images.push(ico.subarray(offset, offset + size));
  }
  return images;
}

/** Content credentials (C2PA, in a JUMBF box) and XMP provenance, in any form. */
const PROVENANCE = /c2pa|jumb|xmpmeta|x:xmptk|<metadata/i;

const EXPECTED = [
  'apple-touch-icon-180.png',
  'favicon-16.png',
  'favicon-32.png',
  'favicon.ico',
  'favicon.svg',
  'icon-192.png',
  'icon-512.png',
  'openfolia-lockup-horizontal-color-dark.svg',
  'openfolia-lockup-horizontal-color-light.svg',
  'openfolia-mark-color-dark.svg',
  'openfolia-mark-color-light.svg',
];

describe('brand assets', () => {
  it('ships the mark, the lockup (light and dark) and the app icon set, nothing else', () => {
    expect(readdirSync(brandDir).sort()).toEqual(EXPECTED);
  });

  it.each(EXPECTED.filter((f) => f.endsWith('.svg')))(
    '%s is a self-contained, outlined SVG',
    (file) => {
      const svg = readFileSync(resolve(brandDir, file), 'utf8');
      expect(svg.startsWith('<svg')).toBe(true);
      expect(svg).toMatch(/viewBox="[\d.\s]+"/);
      expect(svg).not.toMatch(/<script|<foreignObject|<text|<image|<use\b/i);
      expect(svg).not.toMatch(/\b(?:xlink:)?href=|url\(\s*['"]?(?!#)/i);
    },
  );

  it.each(EXPECTED)('%s carries no provenance metadata', (file) => {
    const bytes = readFileSync(resolve(brandDir, file));
    expect(bytes.toString('latin1')).not.toMatch(PROVENANCE);
    const pngs = file.endsWith('.png')
      ? [bytes]
      : file.endsWith('.ico')
        ? icoImages(bytes).filter((img) => img[0] === 0x89)
        : [];
    for (const png of pngs) {
      for (const chunk of pngChunks(png)) {
        // `caBX` is the C2PA chunk; a text chunk may hold XMP or credentials.
        expect(chunk.type, file).not.toBe('caBX');
        expect(chunk.text, `${file} ${chunk.type}`).not.toMatch(PROVENANCE);
      }
    }
  });

  it.each(EXPECTED.filter((f) => f.endsWith('.png')))(
    '%s is a PNG of the size its name gives',
    (file) => {
      const png = readFileSync(resolve(brandDir, file));
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const size = Number(/-(\d+)\.png$/.exec(file)?.[1]);
      // The IHDR chunk comes first: width and height at bytes 16 and 20.
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        size,
        size,
      ]);
    },
  );

  it('has an ICO with the 16, 32 and 48 px icons', () => {
    const ico = readFileSync(resolve(brandDir, 'favicon.ico'));
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    const sizes = Array.from(
      { length: ico.readUInt16LE(4) },
      (_, k) => ico[6 + 16 * k],
    );
    expect(sizes).toEqual([16, 32, 48]);
  });
});
