// Draws the demo content's pictures (#441): each `content/images/source/<name>.svg`, our own
// simple drawings, rendered to `content/images/<name>.png` at twice its size. Content images are
// PNG or JPEG (what the editor uploads and shows), so the SVG files are only their sources. Run
// it after changing a drawing, and commit both:
//
//   node scripts/demo/render-images.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium } from './playwright.mjs';

const dir = join(import.meta.dirname, 'content', 'images');
const sources = readdirSync(join(dir, 'source')).filter((f) =>
  f.endsWith('.svg'),
);
const browser = await chromium.launch();
try {
  for (const file of sources) {
    const svg = readFileSync(join(dir, 'source', file), 'utf8');
    const [, width, height] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg) ?? [];
    if (!width) throw new Error(`${file}: no viewBox`);
    const page = await browser.newPage({
      viewport: { width: Number(width), height: Number(height) },
      deviceScaleFactor: 2,
    });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    const out = join(dir, `${basename(file, '.svg')}.png`);
    await page.screenshot({ path: out, omitBackground: false });
    await page.close();
    console.log(`${file} → ${basename(out)}`);
  }
} finally {
  await browser.close();
}
