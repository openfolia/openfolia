import qrcode from 'qrcode-generator';

/**
 * The quiet zone around a QR code, in modules: the four the standard (ISO/IEC 18004) asks for,
 * so a scanner finds the code next to other print.
 */
export const QR_QUIET_ZONE = 4;

/**
 * Error correction level Q: a quarter of the code may be lost (a scratch, a fold, dirt on a
 * label) and it still reads. Level H holds a little more but makes the code denser, so its
 * modules are smaller at the same printed size; Q is the usual choice for print.
 */
export const QR_ERROR_CORRECTION = 'Q';

/** The longest text a QR code is made of here: a stable address, never content. */
export const MAX_QR_TEXT = 1_000;

/** A QR code's modules: `size` × `size`, without the quiet zone; `dark(row, column)`. */
export interface QrMatrix {
  readonly size: number;
  readonly dark: (row: number, column: number) => boolean;
}

/**
 * The QR code of `text` (#450), made here without any network call: byte mode, the smallest
 * version that holds it, error correction `QR_ERROR_CORRECTION`. Only printable ASCII (a URL
 * as `URL.href` writes it, host and path encoded): the library's byte mode reads each
 * character as one byte, so anything else is refused rather than encoded wrongly.
 */
export function qrCodeMatrix(text: string): QrMatrix {
  if (text.length === 0 || text.length > MAX_QR_TEXT) {
    throw new RangeError(
      `A QR code holds 1 to ${MAX_QR_TEXT} characters here.`,
    );
  }
  if (!/^[\x20-\x7e]+$/.test(text)) {
    throw new RangeError('A QR code holds printable ASCII only here.');
  }
  const code = qrcode(0, QR_ERROR_CORRECTION);
  code.addData(text, 'Byte');
  code.make();
  const size = code.getModuleCount();
  return { size, dark: (row, column) => code.isDark(row, column) };
}

/**
 * The QR code of `text` as an SVG: black modules on a white square with the quiet zone,
 * one path, scaled by its `viewBox` (one unit a module) to whatever size it is printed at,
 * edges kept sharp. `title` is the SVG's text alternative (the address it holds).
 */
export function qrCodeSvg(text: string): string {
  const matrix = qrCodeMatrix(text);
  const side = matrix.size + 2 * QR_QUIET_ZONE;
  let path = '';
  for (let row = 0; row < matrix.size; row++) {
    let column = 0;
    while (column < matrix.size) {
      if (!matrix.dark(row, column)) {
        column++;
        continue;
      }
      const start = column;
      while (column < matrix.size && matrix.dark(row, column)) column++;
      path += `M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${column - start}v1h-${column - start}z`;
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side * 8}" height="${side * 8}" shape-rendering="crispEdges" role="img">`,
    `<title>${escapeXml(text)}</title>`,
    `<rect width="${side}" height="${side}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    '</svg>',
    '',
  ].join('\n');
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
