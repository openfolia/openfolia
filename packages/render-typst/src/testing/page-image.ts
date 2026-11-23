import { Resvg } from '@resvg/resvg-js';
import { PAGE_SIZE_MM, type PageSize } from '@openfolia/content-model';
import { compilePagePngInWorker, type CompileInput } from '../lib/compile.js';
import { DESIGN_INPUT } from '../lib/design.js';

/*
 * Page pictures for tests (not part of the package's build): a page's pixels, and its coarse
 * text sketch for snapshots of a layout.
 */

/** A page's pixels: RGBA, `width` × `height`, on white. */
export interface PagePixels {
  readonly pixels: Buffer;
  readonly width: number;
  readonly height: number;
}

/** The page's height over its width: the design's paper (`DESIGN_INPUT`), else A4. */
export function pageRatio(compile: CompileInput): number {
  let paper: unknown;
  try {
    paper = (
      JSON.parse(compile.inputs?.[DESIGN_INPUT] ?? '{}') as { paper?: unknown }
    ).paper;
  } catch {
    paper = undefined;
  }
  const size =
    typeof paper === 'string' && Object.hasOwn(PAGE_SIZE_MM, paper)
      ? PAGE_SIZE_MM[paper as PageSize]
      : PAGE_SIZE_MM.a4;
  return size.height / size.width;
}

/**
 * Page `page` of `compile`, `width` pixels wide, as pixels (A4, or the design's paper: US
 * Letter, A5); `white`: on a white background, else as the page draws it.
 */
export async function pagePixels(
  compile: CompileInput,
  page: number,
  width: number,
  white = true,
): Promise<PagePixels> {
  const png = await compilePagePngInWorker(compile, { number: page, width });
  const height = Math.round(width * pageRatio(compile));
  const image = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<image width="${width}" height="${height}" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"/></svg>`,
    white ? { background: '#ffffff' } : {},
  ).render();
  // Read once: each read of `pixels` copies them.
  return { pixels: image.pixels, width: image.width, height: image.height };
}

/** Ink levels, light to dark, for a page's sketch. */
const INK = ' .:-=+*#%@';
const SKETCH_COLUMNS = 30;

/**
 * A page as a coarse text picture (`SKETCH_COLUMNS` cells wide, each the darkness of its
 * square): a snapshot of its layout that small anti-aliasing differences do not change.
 */
export async function sketch(
  compile: CompileInput,
  page: number,
): Promise<string> {
  const width = SKETCH_COLUMNS * 8;
  const { pixels, height } = await pagePixels(compile, page, width, false);
  const cell = width / SKETCH_COLUMNS;
  const rows: string[] = [];
  for (let top = 0; top + cell <= height; top += cell) {
    let row = '';
    for (let left = 0; left < width; left += cell) {
      let dark = 0;
      for (let y = top; y < top + cell; y++) {
        for (let x = left; x < left + cell; x++) {
          const i = (y * width + x) * 4;
          const lum =
            (0.2126 * (pixels[i] ?? 255) +
              0.7152 * (pixels[i + 1] ?? 255) +
              0.0722 * (pixels[i + 2] ?? 255)) /
            255;
          dark += 1 - lum;
        }
      }
      const level = Math.min(
        INK.length - 1,
        Math.floor((dark / (cell * cell)) * 2 * INK.length),
      );
      row += INK[level];
    }
    rows.push(row.trimEnd());
  }
  return `\n${rows.join('\n')}\n`;
}
