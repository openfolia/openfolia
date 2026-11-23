import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renamedFont,
  tablesOf,
  themeFont,
  woffFromSfnt,
} from '../testing/fonts.js';
import {
  compileToPdf,
  createWorkspace,
  fontBlobs,
  sfntFromFontFile,
  sfntWithFamily,
  type CoreInput,
} from './compile-core.js';
import { closeWorkerPool, compilePdfInWorker } from './compile.js';

const ttf = themeFont('ttf/Geist-Bold.ttf');
const woff2 = themeFont('Geist-Variable.woff2');
const hebrew = themeFont('NotoSansHebrew-Variable.woff2');

/** Compiling without the host's fonts: only what a test gives, and Typst's own. */
const host = mkdtempSync(join(tmpdir(), 'openfolia-fonts-test-'));
const saved = {
  HOME: process.env['HOME'],
  XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
};
process.env['HOME'] = host;
delete process.env['XDG_DATA_HOME'];
afterAll(async () => {
  await closeWorkerPool();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(host, { recursive: true, force: true });
});

/** The PDF's font names (`/BaseFont`), compiled with only `fonts`. */
function baseFonts(fonts: Uint8Array[], weight = 'regular'): string[] {
  const input: CoreInput = {
    source: `#set text(font: "Geist", weight: "${weight}")\nHello`,
    template: '',
    tokens: '',
    files: {},
    fonts,
    fontDirs: [],
    standard: 'none',
  };
  const workspace = createWorkspace();
  try {
    const result = compileToPdf(input, workspace);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const pdf = Buffer.from(result.data).toString('latin1');
    return [...pdf.matchAll(/\/BaseFont\s*\/[A-Z]{6}\+([^\s/]+)/g)].map(
      ([, name]) => name as string,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const u16 = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);

describe('font files in the compiling child (#555)', () => {
  it('passes a TrueType font as it is', () => {
    expect(sfntFromFontFile(ttf)).toBe(ttf);
    expect(sfntFromFontFile(ttf, 1000)).toBeUndefined();
  });

  it('decodes a WOFF to the same tables', () => {
    const sfnt = sfntFromFontFile(woffFromSfnt(ttf)) as Uint8Array;
    const before = tablesOf(ttf);
    const after = tablesOf(sfnt);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [tag, data] of before) {
      // head's checkSumAdjustment is made again for the new file.
      const same = (b: Uint8Array) =>
        tag === 'head'
          ? Buffer.concat([b.subarray(0, 8), b.subarray(12)])
          : Buffer.from(b);
      expect(same(after.get(tag) as Uint8Array).equals(same(data)), tag).toBe(
        true,
      );
    }
    expect(baseFonts([woffFromSfnt(ttf)], 'bold')).toContain('Geist-Bold');
  });

  it('decodes a WOFF2 (its glyf, loca and hmtx transforms undone) to a font Typst uses', () => {
    for (const font of [woff2, hebrew]) {
      const sfnt = sfntFromFontFile(font) as Uint8Array;
      expect(sfnt).toBeDefined();
      const tables = tablesOf(sfnt);
      for (const tag of ['head', 'glyf', 'loca', 'hmtx', 'maxp', 'name']) {
        expect(tables.has(tag), tag).toBe(true);
      }
      // loca: one more offset than glyphs, ascending, the last the glyf table's length.
      const head = tables.get('head') as Uint8Array;
      const numGlyphs = u16(tables.get('maxp') as Uint8Array, 4);
      const long = u16(head, 50) === 1;
      const loca = tables.get('loca') as Uint8Array;
      const view = new DataView(loca.buffer, loca.byteOffset, loca.byteLength);
      expect(loca.byteLength).toBe((numGlyphs + 1) * (long ? 4 : 2));
      const offset = (i: number) =>
        long ? view.getUint32(i * 4) : view.getUint16(i * 2) * 2;
      for (let i = 0; i < numGlyphs; i++)
        expect(offset(i + 1)).toBeGreaterThanOrEqual(offset(i));
      expect(offset(numGlyphs)).toBe(
        (tables.get('glyf') as Uint8Array).byteLength,
      );
    }
    expect(baseFonts([woff2]).join()).toMatch(/Geist/);
    // Without it, Typst's own font.
    expect(baseFonts([]).join()).not.toMatch(/Geist/);
  });

  it('leaves out, quickly and without throwing, what does not decode', () => {
    const woff = woffFromSfnt(ttf);
    const started = Date.now();
    const broken: Uint8Array[] = [
      new TextEncoder().encode('wOF2 and nothing else'),
      woff2.subarray(0, woff2.byteLength - 10),
      woff.subarray(0, 5000),
      new TextEncoder().encode('ttcf'),
    ];
    let seed = 7;
    for (const font of [woff2, hebrew, woff]) {
      for (let round = 0; round < 60; round++) {
        const flipped = new Uint8Array(font);
        for (let k = 0; k < 3; k++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          flipped[seed % Math.min(flipped.byteLength, 1500)] = seed >>> 24;
        }
        broken.push(flipped);
      }
    }
    for (const font of broken)
      expect(() => sfntFromFontFile(font)).not.toThrow();
    for (const font of broken.slice(0, 4))
      expect(sfntFromFontFile(font)).toBeUndefined();
    expect(sfntFromFontFile(woff2, 1000)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(fontBlobs(broken.slice(0, 4))).toEqual([]);
    // Such a font is ignored: the document compiles with the fallback.
    expect(baseFonts(broken.slice(0, 4)).length).toBeGreaterThan(0);
  });

  it('loads a design font beside the theme’s fonts in a worker (blobs before directories)', async () => {
    // typst-ts aborts the child when memory fonts follow a font directory.
    const proof = woffFromSfnt(
      renamedFont(ttf, 'Proof Sans', { subfamily: 'Bold' }),
    );
    const pdf = await compilePdfInWorker(
      {
        source:
          '#text(font: "Proof Sans", weight: "bold")[Proof] #text(font: "Geist", weight: "bold")[Hello]',
        fonts: [proof],
        standard: 'none',
      },
      { timeoutMs: 30_000 },
    );
    const names = pdf.toString('latin1');
    expect(names).toMatch(/\+ProofSans-Bold/);
    expect(names).toMatch(/\+Geist-Bold/);
  }, 60_000);

  it('compiles with a truncated or corrupted TrueType font, using the fallback', async () => {
    const corrupted = new Uint8Array(ttf);
    corrupted.fill(0xff, 200, 4000);
    for (const font of [ttf.subarray(0, 5000), corrupted]) {
      const pdf = await compilePdfInWorker(
        {
          source: '#set text(font: "Geist")\nHello',
          fonts: [font],
          standard: 'none',
        },
        { timeoutMs: 30_000 },
      );
      expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    }
  }, 60_000);

  it('loads a font under the family it is given, its other names kept; never throws on broken bytes', async () => {
    // Typst would know "Proof Sans Condensed" as "Proof Sans": asked for the role's family,
    // it finds the font all the same.
    const font = renamedFont(ttf, 'Proof Sans Condensed');
    const pdf = await compilePdfInWorker(
      {
        source: '#set text(font: "openfolia-body-font")\nHello',
        fonts: [{ data: woffFromSfnt(font), family: 'openfolia-body-font' }],
        standard: 'none',
      },
      { timeoutMs: 30_000 },
    );
    expect(pdf.toString('latin1')).toMatch(/\+ProofSansCondensed-Regular/);
    const renamed = sfntWithFamily(font, 'openfolia-body-font');
    expect(renamed && tablesOf(renamed).get('OS/2')).toEqual(
      tablesOf(font).get('OS/2'),
    );
    for (let length = 0; length < 4000; length += 13) {
      expect(() => sfntWithFamily(font.subarray(0, length), 'x')).not.toThrow();
    }
    const corrupted = new Uint8Array(font);
    corrupted.fill(0xff, 12, 400);
    expect(sfntWithFamily(corrupted, 'x')).toBeUndefined();
  }, 60_000);
});
