import { InjectionToken } from '@angular/core';

/** The longer side of a rasterised symbol, in pixels: sharp at the sizes it is shown (up to 3em). */
const BOX = 256;
/** SVG artwork larger than this is not rasterised (shown as missing). */
const MAX_SVG_BYTES = 2 * 1024 * 1024;

/**
 * An SVG as a PNG, or null when it cannot be drawn. The editor never makes a `blob:` URL of an
 * SVG (`SHOWN_TYPES`): one opened from it ("Open image in new tab") would be a document of the
 * editor's origin and run its script there. So SVG artwork is drawn here as an image (an `<img>`
 * runs no script and loads nothing outside itself), from a `data:` URL that never enters the
 * page and whose document, were it ever opened, has an opaque origin, then read back as a PNG.
 */
export type RasterizeSvg = (svg: Blob) => Promise<Blob | null>;

export const RASTERIZE_SVG = new InjectionToken<RasterizeSvg>('RASTERIZE_SVG', {
  providedIn: 'root',
  factory: () => rasterizeSvg,
});

/** The aspect ratio (width / height) the SVG's root declares: its width and height, else its viewBox. */
export function svgAspect(text: string): number {
  const root = new DOMParser().parseFromString(
    text,
    'image/svg+xml',
  ).documentElement;
  if (root.localName !== 'svg') return 1;
  const length = (name: string) => {
    const value = root.getAttribute(name)?.trim() ?? '';
    // Absolute lengths only (`24`, `24px`, `2.5cm` is as good): a percentage says nothing.
    return /^\d+(\.\d+)?([a-z]{2})?$/.test(value) ? parseFloat(value) : NaN;
  };
  const width = length('width');
  const height = length('height');
  if (width > 0 && height > 0) return width / height;
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [, , w = NaN, h = NaN] = box;
  return box.length === 4 && w > 0 && h > 0 ? w / h : 1;
}

export async function rasterizeSvg(svg: Blob): Promise<Blob | null> {
  if (svg.size > MAX_SVG_BYTES) return null;
  try {
    const text = await svg.text();
    const ratio = Math.min(Math.max(svgAspect(text), 1 / 8), 8);
    const width = Math.max(1, Math.round(ratio >= 1 ? BOX : BOX * ratio));
    const height = Math.max(1, Math.round(ratio >= 1 ? BOX / ratio : BOX));
    const image = new Image(width, height);
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((png) => resolve(png), 'image/png'),
    );
  } catch {
    // Not an image a browser draws, or a canvas it will not read back: no artwork to show.
    return null;
  }
}
