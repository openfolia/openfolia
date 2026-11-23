import {
  buildSfnt,
  renamedFont,
  sfntTables,
  themeFont,
  woffFromSfnt,
} from '../../../tests/fonts.js';
import {
  FONT_MEDIA_TYPES,
  fontFileFormat,
  inspectFont,
  type FontInspection,
} from './font-file.js';

const regular = themeFont('ttf/Geist-Regular.ttf');
const boldItalic = themeFont('ttf/Geist-BoldItalic.ttf');
const woff2 = themeFont('Geist-Variable.woff2');
const hebrewWoff2 = themeFont('NotoSansHebrew-Variable.woff2');

const facts = (result: FontInspection) => {
  if (!result.ok) throw new Error(`not ok: ${result.detail}`);
  return result.facts;
};

/** A cheap deterministic generator, so a failing case can be found again. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('fontFileFormat', () => {
  it('tells the format by the first four bytes only', () => {
    expect(fontFileFormat(regular)).toBe('ttf');
    expect(fontFileFormat(new TextEncoder().encode('true'))).toBe('ttf');
    expect(fontFileFormat(new TextEncoder().encode('OTTO'))).toBe('otf');
    expect(fontFileFormat(woffFromSfnt(regular))).toBe('woff');
    expect(fontFileFormat(woff2)).toBe('woff2');
    expect(fontFileFormat(new TextEncoder().encode('ttcf'))).toBeUndefined();
    expect(fontFileFormat(new TextEncoder().encode('<svg'))).toBeUndefined();
    expect(fontFileFormat(new Uint8Array([0, 1, 0]))).toBeUndefined();
    expect(FONT_MEDIA_TYPES.woff2).toBe('font/woff2');
  });
});

describe('inspectFont', () => {
  it('reads a TrueType font’s family, style, copyright and licence', () => {
    const read = facts(inspectFont(regular));
    expect(read).toMatchObject({
      format: 'ttf',
      family: 'Geist',
      weight: 400,
      italic: false,
    });
    expect(read.copyright).toMatch(/Geist/);
    expect(read.licence).toMatch(/Open Font License/);
    expect(facts(inspectFont(boldItalic))).toMatchObject({
      weight: 700,
      italic: true,
    });
  });

  it('reads WOFF (inflated) and WOFF2 (brotli) fonts alike', () => {
    expect(facts(inspectFont(woffFromSfnt(regular)))).toEqual({
      ...facts(inspectFont(regular)),
      format: 'woff',
    });
    expect(facts(inspectFont(woff2))).toMatchObject({
      format: 'woff2',
      family: 'Geist',
    });
    expect(facts(inspectFont(hebrewWoff2)).family).toMatch(/Hebrew/);
  });

  it('reads a renamed font as its new family', () => {
    const renamed = renamedFont(regular, 'Proof Sans', {
      subfamily: 'Bold',
      copyright: 'Copyright\u0000 test‮',
      licence: 'Line one\r\nLine two',
    });
    expect(facts(inspectFont(renamed))).toMatchObject({
      family: 'Proof Sans',
      subfamily: 'Bold',
      copyright: 'Copyright test',
      licence: 'Line one\nLine two',
      licenceUrl: null,
    });
  });

  it('refuses what is no font, and a font that is broken', () => {
    expect(inspectFont(new TextEncoder().encode('<html>'))).toMatchObject({
      ok: false,
      reason: 'not-a-font',
    });
    expect(inspectFont(new TextEncoder().encode('ttcf....'))).toMatchObject({
      ok: false,
      reason: 'not-a-font',
    });
    // A signature and nothing behind it.
    expect(inspectFont(regular.subarray(0, 100))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    // A font without outlines: the glyf tag renamed in the directory.
    const cut = new Uint8Array(regular);
    for (let i = 0; i < sfntTables(regular).tables.length; i++) {
      const p = 12 + i * 16;
      if (String.fromCharCode(...cut.subarray(p, p + 4)) === 'glyf') {
        cut.set(new TextEncoder().encode('xxxx'), p);
      }
    }
    expect(inspectFont(cut)).toMatchObject({
      ok: false,
      reason: 'malformed',
      detail: expect.stringMatching(/outlines/),
    });
    // A WOFF whose header says another length.
    const woff = woffFromSfnt(regular);
    expect(inspectFont(woff.subarray(0, woff.byteLength - 4))).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses a WOFF2 that decodes to more than the bound', () => {
    expect(inspectFont(woff2, { maxDecodedBytes: 1000 })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
    expect(
      inspectFont(woffFromSfnt(regular), { maxDecodedBytes: 1000 }),
    ).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('decodes a name table of thousands of records sharing one long string once, in part', () => {
    // Every record names the family in the same 64 KiB of characters that cleaning removes:
    // each decoded again would take seconds of the API's one thread.
    const count = 5000;
    const long = 0xfff0;
    const table = new Uint8Array(6 + count * 12 + long);
    const view = new DataView(table.buffer);
    view.setUint16(2, count);
    view.setUint16(4, 6 + count * 12);
    for (let i = 0; i < count; i++) {
      const at = 6 + i * 12;
      view.setUint16(at, 3);
      view.setUint16(at + 2, 1);
      view.setUint16(at + 4, 0x0409);
      view.setUint16(at + 6, 1);
      view.setUint16(at + 8, long);
    }
    for (let i = 0; i < long; i += 2) table[6 + count * 12 + i + 1] = 1;
    const { flavor, tables } = sfntTables(regular);
    const font = buildSfnt(flavor, [
      ...tables.filter((t) => t.tag !== 'name'),
      { tag: 'name', data: table },
    ]);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      expect(inspectFont(font)).toMatchObject({
        ok: false,
        reason: 'malformed',
      });
      // The family's one record decoded once, a short part of it.
      expect(decode).toHaveBeenCalledTimes(1);
      expect((decode.mock.calls[0]?.[0] as Uint8Array).byteLength).toBe(800);
    } finally {
      decode.mockRestore();
    }
  });

  it('never throws on cut, flipped or random bytes', () => {
    const small = hebrewWoff2;
    const woff = woffFromSfnt(regular);
    for (const font of [
      small,
      woff.subarray(0, 4000),
      regular.subarray(0, 3000),
    ]) {
      for (let length = 0; length <= font.byteLength; length += 7) {
        expect(() => inspectFont(font.subarray(0, length))).not.toThrow();
      }
    }
    const next = random(555);
    for (const font of [small, woff, regular]) {
      for (let round = 0; round < 200; round++) {
        const flipped = new Uint8Array(font);
        for (let k = 0; k < 4; k++) {
          const i = Math.floor(next() * Math.min(flipped.byteLength, 2048));
          flipped[i] = Math.floor(next() * 256);
        }
        expect(() => inspectFont(flipped)).not.toThrow();
      }
    }
    for (let round = 0; round < 200; round++) {
      const bytes = new Uint8Array(64 + Math.floor(next() * 512));
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = Math.floor(next() * 256);
      bytes.set(
        [
          [0, 1, 0, 0],
          [0x4f, 0x54, 0x54, 0x4f],
          [0x77, 0x4f, 0x46, 0x46],
          [0x77, 0x4f, 0x46, 0x32],
        ][round % 4] as number[],
      );
      expect(() => inspectFont(bytes)).not.toThrow();
    }
  });
});
