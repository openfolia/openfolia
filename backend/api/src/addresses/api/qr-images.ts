import {
  qrCodeMatrix,
  qrCodeSvg,
  QR_QUIET_ZONE,
} from '@openfolia/render-typst';
import sharp from 'sharp';

/** A QR code's image format (`…/qr.svg`, `…/qr.png`). */
export type QrFormat = 'svg' | 'png';

/** Pixels per module of the PNG: 8, so a short address is about 300 pixels wide. */
export const QR_PNG_SCALE = 8;

/**
 * The QR code of `url` (#450), made here without a network call: an SVG (`qrCodeSvg`, for
 * print at any size) or a PNG (black and white, `QR_PNG_SCALE` pixels a module, the quiet
 * zone included).
 */
export async function qrImage(
  url: string,
  format: QrFormat,
): Promise<{ readonly bytes: Uint8Array; readonly type: string }> {
  if (format === 'svg') {
    return {
      bytes: new TextEncoder().encode(qrCodeSvg(url)),
      type: 'image/svg+xml',
    };
  }
  const matrix = qrCodeMatrix(url);
  const modules = matrix.size + 2 * QR_QUIET_ZONE;
  const side = modules * QR_PNG_SCALE;
  const pixels = Buffer.alloc(side * side, 0xff);
  for (let row = 0; row < matrix.size; row++) {
    for (let column = 0; column < matrix.size; column++) {
      if (!matrix.dark(row, column)) continue;
      const top = (row + QR_QUIET_ZONE) * QR_PNG_SCALE;
      const left = (column + QR_QUIET_ZONE) * QR_PNG_SCALE;
      for (let y = top; y < top + QR_PNG_SCALE; y++) {
        pixels.fill(0, y * side + left, y * side + left + QR_PNG_SCALE);
      }
    }
  }
  const png = await sharp(pixels, {
    raw: { width: side, height: side, channels: 1 },
  })
    .png({ compressionLevel: 9, palette: true, colours: 2 })
    .toBuffer();
  return { bytes: new Uint8Array(png), type: 'image/png' };
}
