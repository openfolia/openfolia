import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Locator, Page } from '@playwright/test';
import { ROOT } from '../stack/stack.ts';

/** Where the guide's images go: the docs site serves them at `/images/guide/<lang>/<name>.webp`. */
export const IMAGES_DIR = join(ROOT, 'frontend/docs/public/images/guide');

/** A shot's name: lowercase words and hyphens, so it is a safe file name and nothing else. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The WebP quality: small files, text still sharp at 1×. */
const QUALITY = 0.86;

/**
 * Writes a screenshot of `target` (the page's window, or one element) as
 * `<IMAGES_DIR>/<lang>/<name>.webp`. Chromium makes the PNG; a blank page of the same browser
 * encodes it as WebP (`canvas.toBlob`), so no image tool is needed.
 */
export async function shot(
  browser: Browser,
  target: Page | Locator,
  lang: string,
  name: string,
): Promise<void> {
  if (!NAME.test(name) || !NAME.test(lang))
    throw new Error(`Not a shot name: ${lang}/${name}`);
  const png = await target.screenshot({ animations: 'disabled', caret: 'hide' });
  const webp = await toWebp(browser, png);
  const dir = join(IMAGES_DIR, lang);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.webp`), webp);
}

async function toWebp(browser: Browser, png: Buffer): Promise<Buffer> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const base64 = await page.evaluate(
      async ({ data, quality }) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: 'image/png' }),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
        if (blob.type !== 'image/webp') throw new Error('No WebP encoder');
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let text = '';
        for (const byte of buffer) text += String.fromCharCode(byte);
        return btoa(text);
      },
      { data: png.toString('base64'), quality: QUALITY },
    );
    return Buffer.from(base64, 'base64');
  } finally {
    await context.close();
  }
}
