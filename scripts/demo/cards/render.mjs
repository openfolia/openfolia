// Renders the hero's cards frame by frame (#441): every CSS animation stepped to the exact frame
// time and screenshotted, so there is no screen-recording judder, then to H.264 (`crf 14`). Also
// writes three stills per card (start, middle, end) for the owner to look at.
//
//   node scripts/demo/cards/render.mjs [--card intro|end] [--lang en|de] [--stills-only]
//
// Without options, both cards in both languages. Writes, all in `.demo/` (git-ignored):
//   .demo/cards/<card>-<lang>.html        the filled page (open it in a browser to preview)
//   .demo/cards/<card>-<lang>.mp4         the card, 1920×1080, 30 fps
//   .demo/stills/cards/<card>-<lang>-<start|middle|end>.png

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEMO_DIR } from '../paths.mjs';
import { chromium } from '../playwright.mjs';
import { CARD_LANGS, CARDS, cardPage, STILL_TIMES } from './cards.mjs';

export const FPS = 30;
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

/** The frame shown at `seconds`. */
export const frameAt = (seconds) => Math.round(seconds * FPS);

async function render(browser, card, lang, { stillsOnly }) {
  const dir = join(DEMO_DIR, 'cards');
  const frames = join(dir, 'frames', `${card}-${lang}`);
  const stills = join(DEMO_DIR, 'stills', 'cards');
  mkdirSync(stills, { recursive: true, mode: 0o700 });
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true, mode: 0o700 });
  const html = join(dir, `${card}-${lang}.html`);
  writeFileSync(html, cardPage(card, lang));

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  await page.goto(pathToFileURL(html).href);
  await page.evaluate(() => document.fonts.ready);
  const total = frameAt(CARDS[card].seconds);
  const wanted = Object.entries(STILL_TIMES[card]).map(([name, seconds]) => ({
    name,
    frame: frameAt(seconds),
  }));
  const shoot = stillsOnly
    ? wanted.map((w) => w.frame)
    : [...Array(total).keys()];
  for (const f of shoot) {
    await page.evaluate(
      (ms) => {
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = ms;
        }
      },
      (f / FPS) * 1000,
    );
    await page.screenshot({
      path: join(frames, `${String(f).padStart(4, '0')}.png`),
    });
  }
  await page.close();
  for (const { name, frame } of wanted) {
    const still = join(stills, `${card}-${lang}-${name}.png`);
    copyFileSync(join(frames, `${String(frame).padStart(4, '0')}.png`), still);
    console.log(still);
  }
  if (stillsOnly) return;
  const out = join(dir, `${card}-${lang}.mp4`);
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-y', '-framerate', String(FPS)],
    ...['-i', join(frames, '%04d.png')],
    ...['-c:v', 'libx264', '-crf', '14', '-preset', 'slow'],
    ...['-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
  ]);
  rmSync(frames, { recursive: true, force: true });
  console.log(`${out} (${total} frames)`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      card: { type: 'string', multiple: true },
      lang: { type: 'string', multiple: true },
      'stills-only': { type: 'boolean' },
    },
  });
  const cards = values.card ?? Object.keys(CARDS);
  const langs = values.lang ?? CARD_LANGS;
  for (const card of cards) {
    if (!Object.hasOwn(CARDS, card))
      throw new Error(`--card: one of ${Object.keys(CARDS)}`);
  }
  for (const lang of langs) {
    if (!CARD_LANGS.includes(lang))
      throw new Error(`--lang: one of ${CARD_LANGS}`);
  }
  const browser = await chromium.launch();
  try {
    for (const card of cards) {
      for (const lang of langs) {
        await render(browser, card, lang, {
          stillsOnly: values['stills-only'] ?? false,
        });
      }
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
