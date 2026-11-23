import {
  closeWorkerPool,
  compilePagePngInWorker,
  PAGE_WIDTH,
  TypstPageNotFoundError,
} from './compile.js';
import { MAX_PAGE_PIXELS, oklabToRgb, pageSvg } from './compile-core.js';

afterAll(() => closeWorkerPool());

const isPng = (data: Uint8Array) =>
  Buffer.from(data.subarray(0, 8)).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
/** Width and height from the PNG's IHDR chunk. */
const size = (png: Uint8Array) => {
  const view = Buffer.from(png);
  return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
};

const source = `#import "template.typ": *
#show: manual.with(title: "Operating manual", subtitle: "Model Large")
= Safety
#safety(severity: "warning", hazard: "Hot surface", symbols: ("openfolia/missing-symbol.svg",))[Let it cool down.]
Visit #link("https://example.com/?a=1&b=<2>\\"x")[the help]. #link(<end>)[Jump].
#figure(table(columns: 2, table.header[A][B], [1], [2]), caption: [Values]) <end>
`;

describe('page images', () => {
  it(
    'renders a page as a PNG of the asked width, in A4 proportions',
    { timeout: 60_000 },
    async () => {
      const cover = await compilePagePngInWorker(
        { source },
        { number: 1, width: 480 },
      );
      expect(isPng(cover)).toBe(true);
      expect(size(cover).width).toBe(480);
      expect(size(cover).height).toBe(Math.round((480 * 297) / 210));
      // The last page has links (one to a URL with `&`, `<` and a quote): the rasteriser takes it.
      const content = await compilePagePngInWorker(
        { source },
        { number: 3, width: 200 },
      );
      expect(isPng(content)).toBe(true);
      expect(size(content).width).toBe(200);
    },
  );

  it(
    'says how many pages there are when the page does not exist',
    { timeout: 60_000 },
    async () => {
      const error: unknown = await compilePagePngInWorker(
        { source },
        { number: 4, width: 100 },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TypstPageNotFoundError);
      expect((error as TypstPageNotFoundError).pages).toBe(3);
    },
  );

  it('refuses pages and widths out of bounds', async () => {
    for (const page of [
      { number: 0, width: 100 },
      { number: 1.5, width: 100 },
      { number: 1, width: PAGE_WIDTH.min - 1 },
      { number: 1, width: PAGE_WIDTH.max + 1 },
      { number: 1, width: 100.5 },
    ]) {
      await expect(
        compilePagePngInWorker({ source }, page),
      ).rejects.toBeInstanceOf(RangeError);
    }
  });

  it(
    'keeps each page its own size and fill, and caps the pixels of a very tall page',
    { timeout: 60_000 },
    async () => {
      const mixed = `#set page(width: 100pt, height: 80pt, fill: oklch(40%, 0.1, 250deg))
One
#set page(width: 200pt, height: 80pt, fill: white)
Two
#set page(width: 10pt, height: 4000pt, fill: white)
Three`;
      const first = await compilePagePngInWorker(
        { source: mixed },
        { number: 1, width: 100 },
      );
      expect(size(first)).toEqual({ width: 100, height: 80 });
      const second = await compilePagePngInWorker(
        { source: mixed },
        { number: 2, width: 100 },
      );
      expect(size(second)).toEqual({ width: 100, height: 40 });
      const tall = size(
        await compilePagePngInWorker(
          { source: mixed },
          { number: 3, width: PAGE_WIDTH.max },
        ),
      );
      expect(tall.width * tall.height).toBeLessThanOrEqual(MAX_PAGE_PIXELS);
      expect(tall.height).toBeGreaterThan(tall.width);
    },
  );
});

describe('pageSvg', () => {
  // The compiler's plain SVG: pages stacked, links with unescaped targets, oklch colours.
  const plain = [
    '<svg class="typst-doc" viewBox="0 0 100 300" width="100pt" height="300pt" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">',
    '    <path class="typst-shape" fill="#ffffff" d="M 0 0v 100 h 100 v -100 Z "/>',
    '    <g>',
    '        <path fill="oklch(62.800% 0.25770 29.230deg)" d="M 0 0 h 1"/>',
    '    </g>',
    '    <path class="typst-shape" fill="#ffffff" d="M 0 0v 200 h 100 v -200 Z "/>',
    '    <g transform="matrix(1 0 0 1 0 100)">',
    '        <a transform="matrix(1 0 0 1 5 5)" href="https://x/?a=1&b=<g>&quot;" xlink:href="https://x/?a=1&b=<g>&quot;">',
    '            <use xlink:href="#g1" fill="oklab(97.200% 0.00976 0.01396)"/>',
    '        </a>',
    '    </g>',
    '    <defs id="glyph">',
    '        <path id="g1" d="M 0 0 h 1"/>',
    '    </defs>',
    '</svg>',
  ].join('\n');

  it('cuts one page out, the view box on it, links dropped, colours in rgb()', () => {
    const first = pageSvg(plain, 1);
    expect(first).toContain('viewBox="0 0 100 100"');
    expect(first).toContain('rgb(255,0,0)');
    expect(first).not.toContain('transform="matrix(1 0 0 1 0 100)"');
    expect(first).toContain('<path id="g1"');

    const second = pageSvg(plain, 2);
    expect(second).toContain('viewBox="0 100 100 200"');
    expect(second).toContain('<g transform="matrix(1 0 0 1 5 5)">');
    expect(second).not.toMatch(/<a\b|href="https|oklch|oklab|&b/);
    expect(second).toContain('xlink:href="#g1"');

    expect(pageSvg(plain, 3)).toBeUndefined();
    expect(pageSvg(plain, 0)).toBeUndefined();
  });

  it("takes a page's size and fill from the shape before its group", () => {
    const sized = plain
      .replace(
        'd="M 0 0v 200 h 100 v -200 Z "',
        'fill="oklch(40.000% 0.10000 250.000deg)" d="M 0 0v 200 h 60 v -200 Z "',
      )
      .replace(
        '<path class="typst-shape" fill="#ffffff" fill="',
        '<path class="typst-shape" fill="',
      );
    const second = pageSvg(sized, 2);
    expect(second).toContain('viewBox="0 100 60 200"');
    expect(second).toMatch(
      /<g transform="matrix\(1 0 0 1 0 100\)"><path class="typst-shape" fill="rgb\(\d+,\d+,\d+\)"/,
    );
  });

  it('converts the colour forms the rasteriser cannot read', () => {
    const coloured = plain.replace(
      'fill="oklch(62.800% 0.25770 29.230deg)"',
      'fill="hsl(0.000deg 100.000% 50.000%)" stroke="color(srgb-linear 1.00000 0.00000 0.00000 / 50%)"',
    );
    const page = pageSvg(coloured, 1);
    expect(page).toContain('fill="rgb(255,0,0)" stroke="rgba(255,0,0,0.5)"');
  });

  it('refuses references to anything but its definitions and embedded images', () => {
    for (const href of ['/etc/x.png', 'file:///x.png', 'https://x/y.png']) {
      expect(() =>
        pageSvg(plain.replace('xlink:href="#g1"', `xlink:href="${href}"`), 2),
      ).toThrow(/reference/);
    }
    expect(() =>
      pageSvg(`<!DOCTYPE svg [<!ENTITY x "y">]>${plain}`, 1),
    ).toThrow(/declaration/);
  });

  it('converts oklch and oklab to sRGB', () => {
    expect(oklabToRgb('oklch', 62.8, 0.2577, 29.23)).toBe('rgb(255,0,0)');
    expect(oklabToRgb('oklch', 100, 0, 0)).toBe('rgb(255,255,255)');
    expect(oklabToRgb('oklab', 0, 0, 0, '50%')).toBe('rgba(0,0,0,0.5)');
    expect(oklabToRgb('oklch', 50, 0.1, -10, '0.25')).toMatch(
      /^rgba\(\d+,\d+,\d+,0\.25\)$/,
    );
  });
});
