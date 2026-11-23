import { Resvg } from '@resvg/resvg-js';
import { closeWorkerPool, compilePagePngInWorker } from './compile.js';

afterAll(() => closeWorkerPool());

const WIDTH = 420;

/** The title page as RGBA pixels (the PNG decoded by drawing it into an SVG). */
async function titlePage(source: string, files?: Record<string, Uint8Array>) {
  const png = await compilePagePngInWorker(
    { source, ...(files && { files }) },
    { number: 1, width: WIDTH },
  );
  const height = Math.round((WIDTH * 297) / 210);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}">` +
    `<image width="${WIDTH}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`;
  const image = new Resvg(svg).render();
  return { pixels: image.pixels, width: image.width };
}

/** How many pixels of the logo slot (top left, inside the margin) are close to `rgb`. */
function count(
  page: { pixels: Buffer; width: number },
  rgb: [number, number, number],
) {
  const cm = WIDTH / 21;
  let n = 0;
  for (let y = Math.floor(2.2 * cm); y < Math.ceil(3.6 * cm); y++) {
    for (let x = Math.floor(2.2 * cm); x < Math.ceil(5 * cm); x++) {
      const i = (y * page.width + x) * 4;
      const d = [0, 1, 2].map((k) => Math.abs(page.pixels[i + k]! - rgb[k]!));
      if (Math.max(...d) <= 24) n++;
    }
  }
  return n;
}

const SAGE: [number, number, number] = [0x69, 0x99, 0x5d];
const MAGENTA: [number, number, number] = [0xff, 0x00, 0xff];

const doc = (state = '') => `#import "template.typ": *
#show: manual.with(title: "Operating manual", subtitle: "Model Large")
${state}
= Safety
Text.
`;

describe('the title page logo', () => {
  it(
    "shows the default brand's mark when no logo is set",
    { timeout: 60_000 },
    async () => {
      const page = await titlePage(doc());
      expect(count(page, SAGE)).toBeGreaterThan(10);
    },
  );

  it(
    "shows branding's own logo instead, when the document sets one",
    { timeout: 60_000 },
    async () => {
      const own = new TextEncoder().encode(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff00ff"/></svg>',
      );
      const page = await titlePage(
        doc(
          '#state("openfolia-document", (:)).update((logo: "brand/own.svg"))',
        ),
        { 'brand/own.svg': own },
      );
      expect(count(page, MAGENTA)).toBeGreaterThan(10);
      expect(count(page, SAGE)).toBe(0);
    },
  );
});
