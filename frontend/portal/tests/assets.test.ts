import { createHash } from 'node:crypto';
import {
  attachmentAsset,
  AssetError,
  HashMismatchError,
  imageAsset,
  looksLikeMarkup,
  rasteriseSvg,
  symbolAsset,
} from '../build/assets.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script><rect width="8" height="8"/></svg>';

describe('the files a site serves', () => {
  it('keeps a raster image, by its hash', async () => {
    const png = new Uint8Array(PNG);
    expect((await imageAsset(hash(png), png)).file).toBe(`${hash(png)}.png`);
  });

  it('draws an SVG to a PNG, its script gone', async () => {
    const svg = bytes(SVG);
    const asset = await imageAsset(hash(svg), svg);
    expect(asset.file).toBe(`${hash(svg)}.png`);
    expect(Buffer.from(asset.bytes.subarray(0, 4)).toString('latin1')).toBe(
      '\x89PNG',
    );
    const symbol = await symbolAsset('w001', svg);
    expect(symbol.file).toMatch(/^[0-9a-f]{64}\.png$/);
  });

  it.each([
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://example.com/a.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://example.com/x)"/></svg>',
  ])('refuses an SVG that reaches outside itself: %s', async (svg) => {
    await expect(rasteriseSvg(bytes(svg))).rejects.toThrow(AssetError);
  });

  it('refuses an SVG in another encoding than UTF-8, and one too large to draw', async () => {
    const utf16 = new Uint8Array(
      Buffer.from(
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
        'utf16le',
      ),
    );
    await expect(rasteriseSvg(utf16)).rejects.toThrow('not UTF-8');
    const huge = bytes(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"><rect width="1" height="1"/></svg>',
    );
    await expect(rasteriseSvg(huge)).rejects.toThrow('cannot be drawn');
  });

  it('refuses bytes that do not match the hash, as an error that fails the build', async () => {
    const image = imageAsset('0'.repeat(64), new Uint8Array(PNG));
    await expect(image).rejects.toThrow(HashMismatchError);
    await expect(image).rejects.not.toThrow(AssetError);
    await expect(image).rejects.toThrow('do not match');
    expect(() =>
      attachmentAsset('0'.repeat(64), bytes('{}'), 'application/json'),
    ).toThrow(HashMismatchError);
  });

  it('writes an attachment as a plain type only when its bytes are that type', () => {
    const json = bytes('{"a":1}');
    expect(attachmentAsset(hash(json), json, 'application/json').file).toBe(
      `${hash(json)}.json`,
    );
    const html = bytes('  <html><script>alert(1)</script></html>');
    expect(attachmentAsset(hash(html), html, 'application/json').file).toBe(
      `${hash(html)}.bin`,
    );
    expect(attachmentAsset(hash(html), html, 'text/html').file).toBe(
      `${hash(html)}.bin`,
    );
    const notPdf = bytes('hello');
    expect(attachmentAsset(hash(notPdf), notPdf, 'application/pdf').file).toBe(
      `${hash(notPdf)}.bin`,
    );
    const pdf = bytes('%PDF-1.7\n');
    expect(attachmentAsset(hash(pdf), pdf, 'application/pdf').file).toBe(
      `${hash(pdf)}.pdf`,
    );
    const exe = bytes('MZ\x90\x00');
    expect(attachmentAsset(hash(exe), exe, undefined).file).toBe(
      `${hash(exe)}.bin`,
    );
  });

  it('takes markup after a byte order mark or in UTF-16 for markup', () => {
    expect(looksLikeMarkup(bytes('﻿ <svg/>'))).toBe(true);
    expect(
      looksLikeMarkup(new Uint8Array(Buffer.from('<html>', 'utf16le'))),
    ).toBe(true);
    expect(looksLikeMarkup(bytes('a,b\n1,2'))).toBe(false);
  });
});
