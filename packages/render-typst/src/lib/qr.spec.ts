import { Resvg } from '@resvg/resvg-js';
import type { ResolvedManual } from '@openfolia/content-model';
import jsQRModule from 'jsqr';
import {
  closeWorkerPool,
  compilePagePngInWorker,
  compilePdfInWorker,
} from './compile.js';
import { qrCodeMatrix, qrCodeSvg, QR_QUIET_ZONE } from './qr.js';
import { renderTypst } from './render.js';
import { DEFAULT_TEMPLATE } from './template.js';

// jsqr is CommonJS typed as an ES module: at run time its default import is the function.
const jsQR = jsQRModule as unknown as typeof jsQRModule.default;

afterAll(() => closeWorkerPool());

const ADDRESS = 'https://docs.example.com/d/north/operating/model=large/en';

/** Reads the QR code in an RGBA image; undefined when none is found. */
function decode(pixels: Uint8Array, width: number, height: number) {
  return (
    jsQR(new Uint8ClampedArray(pixels), width, height, {
      inversionAttempts: 'dontInvert',
    })?.data ?? undefined
  );
}

/** An SVG drawn at `width` pixels, as RGBA. */
function raster(svg: string, width: number) {
  const image = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: '#ffffff',
  }).render();
  return { pixels: image.pixels, width: image.width, height: image.height };
}

describe('QR codes (#450)', () => {
  it('encodes the address, read back from the SVG', () => {
    const svg = qrCodeSvg(ADDRESS);
    const { pixels, width, height } = raster(svg, 400);
    expect(decode(pixels, width, height)).toBe(ADDRESS);
    expect(svg).toContain(`<title>${ADDRESS}</title>`);
  });

  it('keeps a quiet zone of four light modules on every side', () => {
    const matrix = qrCodeMatrix(ADDRESS);
    const side = matrix.size + 2 * QR_QUIET_ZONE;
    const moduleSize = 10;
    const { pixels, width } = raster(qrCodeSvg(ADDRESS), side * moduleSize);
    const light = (x: number, y: number) =>
      (pixels[(y * width + x) * 4] ?? 0) > 200;
    const zone = QR_QUIET_ZONE * moduleSize;
    for (let i = 0; i < side * moduleSize; i += 3) {
      for (let d = 1; d < zone - 1; d += 3) {
        expect(light(i, d)).toBe(true);
        expect(light(d, i)).toBe(true);
        expect(light(i, side * moduleSize - 1 - d)).toBe(true);
        expect(light(side * moduleSize - 1 - d, i)).toBe(true);
      }
    }
    // The finder pattern starts right after it.
    expect(light(zone + 2, zone + 2)).toBe(false);
  });

  it('makes the same code for the same text', () => {
    expect(qrCodeSvg(ADDRESS)).toBe(qrCodeSvg(ADDRESS));
  });

  it('refuses text it would encode wrongly or that is no address', () => {
    expect(() => qrCodeSvg('https://example.com/ä')).toThrow(RangeError);
    expect(() => qrCodeSvg('')).toThrow(RangeError);
    expect(() => qrCodeSvg('x'.repeat(1_001))).toThrow(RangeError);
  });
});

const manual = {
  title: 'Operating manual',
  lang: 'en',
  variant: {},
  entries: [
    {
      kind: 'module',
      module: 'm',
      title: 'Safety',
      lang: 'en',
      blocks: [
        {
          type: 'paragraph',
          id: 'm--p',
          content: [{ type: 'text', text: 'Text.' }],
        },
      ],
    },
  ],
  issues: [],
  hidden: [],
  origins: {},
  anchors: {},
} as unknown as ResolvedManual;

const WIDTH = 1600;

/** A page of the manual with its QR code, as RGBA. */
async function page(
  placement: 'title-page' | 'back-cover',
  number: number,
  of: ResolvedManual = manual,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const { source } = renderTypst(of, {
    qrCode: { path: 'qr/address.svg', url: ADDRESS, placement },
  });
  const png = await compilePagePngInWorker(
    {
      source,
      files: {
        'qr/address.svg': new TextEncoder().encode(qrCodeSvg(ADDRESS)),
      },
    },
    { number, width: WIDTH },
  );
  const height = Math.round((WIDTH * 297) / 210);
  return raster(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">` +
      `<image width="${WIDTH}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`,
    WIDTH,
  );
}

describe('the QR code in the PDF (#450)', () => {
  it(
    'is placed on the title page, and reads as the address',
    { timeout: 60_000 },
    async () => {
      const title = await page('title-page', 1);
      expect(decode(title.pixels, title.width, title.height)).toBe(ADDRESS);
    },
  );

  it(
    'is placed on a page of its own at the end, and only there',
    { timeout: 60_000 },
    async () => {
      const title = await page('back-cover', 1);
      expect(decode(title.pixels, title.width, title.height)).toBeUndefined();
      // Title page, contents, the module, then the back cover.
      const last = await page('back-cover', 4);
      expect(decode(last.pixels, last.width, last.height)).toBe(ADDRESS);
    },
  );

  it.each(['title-page', 'back-cover'] as const)(
    'keeps the PDF within PDF/UA-1 (%s): the code is an image with the address as its alt text',
    { timeout: 60_000 },
    async (placement) => {
      const { source } = renderTypst(manual, {
        qrCode: { path: 'qr/address.svg', url: ADDRESS, placement },
      });
      const pdf = await compilePdfInWorker({
        source,
        standard: 'ua-1',
        files: {
          'qr/address.svg': new TextEncoder().encode(qrCodeSvg(ADDRESS)),
        },
      });
      expect(Buffer.from(pdf).toString('latin1')).toContain('/Alt');
    },
  );

  describe('in a right-to-left manual (#458)', () => {
    const arabic = {
      ...manual,
      title: 'دليل التشغيل',
      lang: 'ar',
      entries: [
        {
          kind: 'module',
          module: 'm',
          title: 'السلامة',
          lang: 'ar',
          blocks: [
            {
              type: 'paragraph',
              id: 'm--p',
              content: [{ type: 'text', text: 'نص.' }],
            },
          ],
        },
      ],
    } as unknown as ResolvedManual;
    const FILES = {
      'qr/address.svg': new TextEncoder().encode(qrCodeSvg(ADDRESS)),
    };
    // Fails the compile when the address under the code is set right to left, where bidi
    // would move its slashes and dots.
    const CHECK =
      '#show "docs.example.com": it => { context assert(text.dir == ltr, message: "address set right to left"); it }\n';

    it.each([
      ['title-page', 1],
      ['back-cover', 4],
    ] as const)(
      'is not mirrored (%s): the code reads as the address',
      { timeout: 60_000 },
      async (placement, number) => {
        const shown = await page(placement, number, arabic);
        expect(decode(shown.pixels, shown.width, shown.height)).toBe(ADDRESS);
      },
    );

    it.each(['title-page', 'back-cover'] as const)(
      'sets the address under the code left to right (%s)',
      { timeout: 60_000 },
      async (placement) => {
        const qrCode = { path: 'qr/address.svg', url: ADDRESS, placement };
        const { source } = renderTypst(arabic, { qrCode });
        expect(source).toContain('dir: rtl');
        await expect(
          compilePdfInWorker({ source: CHECK + source, files: FILES }),
        ).resolves.toBeDefined();
        // The check bites: the same template without the explicit direction fails it.
        const bare = DEFAULT_TEMPLATE.replace(
          'text(dir: ltr, size: 7pt',
          'text(size: 7pt',
        );
        expect(bare).not.toBe(DEFAULT_TEMPLATE);
        const custom = renderTypst(arabic, {
          qrCode,
          templatePath: 'bare.typ',
        });
        await expect(
          compilePdfInWorker({
            source: CHECK + custom.source,
            files: { ...FILES, 'bare.typ': new TextEncoder().encode(bare) },
          }),
        ).rejects.toThrow(/address set right to left/);
      },
    );
  });

  it('is left out without the option', () => {
    const { source } = renderTypst(manual);
    expect(source).not.toContain('qr-code');
    expect(source).not.toContain('qr: (');
  });
});
