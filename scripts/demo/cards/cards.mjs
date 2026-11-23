// The hero's cards (#441, `docs/demo-videos.md`, "The shared look"): the intro and the end card
// as pages, per language, from the templates next to this file. The texts are here, the look is
// `look.mjs`'s, the fonts and the mark are the theme's (`frontend/theme`), so a rebrand there
// reaches the cards without editing them.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_NAME } from '../brand.mjs';
import { fontFaces, GRAIN_SVG, LOCKUP_FILE, LOOK } from '../look.mjs';

export const CARDS = {
  /** Seconds each card runs; its last 0.3 s go into the crossfade. */
  intro: { seconds: 7.4 },
  end: { seconds: 6.6 },
};
export const CARD_LANGS = ['en', 'de'];

/**
 * The frames shown as stills for the owner: start, middle and end, each where the card holds
 * still (the very first and last frames are the bare graphite).
 */
export const STILL_TIMES = {
  intro: { start: 1.2, middle: 2.65, end: 6.3 },
  end: { start: 0.8, middle: 2.3, end: 4.8 },
};

/**
 * The texts on the cards: the two-beat line (second beat brighter), the demo module's title and
 * the three manuals' titles, as the demo content has them. The module's ID shows as it is, the
 * same in every language.
 */
export const MODULE_ID = 'changing-a-wheel';
export const CARD_TEXTS = {
  en: {
    first: 'Write it once.',
    second: 'Publish every manual.',
    module: 'Changing a wheel',
    manuals: ['Owner’s manual', 'Quick start guide', 'Service booklet'],
  },
  de: {
    first: 'Ein Modul.',
    second: 'Jede Anleitung.',
    module: 'Rad wechseln',
    manuals: ['Betriebsanleitung', 'Kurzanleitung', 'Serviceheft'],
  },
};

/**
 * The cards' greys on the graphite, three steps of text and one of drawing. Every text is at
 * least 4.5:1 against the lightest background behind it (measured on the rendered frames: the
 * module's page, the manuals' pages, the graphite under the line), and the steps stay apart: the
 * dim labels and the first beat read clearly darker than the bright second beat.
 */
export const CARD_COLORS = {
  /** The bright beat and the module's title: the theme's dark-mode text. */
  ink: '#eef0ec',
  /** The first beat and the manuals' titles. */
  muted: '#a4a9b1',
  /** The module's ID and the language tags: the dimmest text. */
  dim: '#94989f',
  /** The bullets of the placeholder lines: drawing, not text. */
  mark: '#5d626a',
};

/**
 * The lightest background behind each text step, as measured on the rendered cards (the 99th
 * percentile of the pixels in the text's box, with the text hidden).
 */
export const CARD_SURFACES = {
  /** The module's page in the intro, over the graphite near the top. */
  modulePage: '#2b2c2f',
  /** A manual's front page. */
  manualPage: '#26282d',
  /** The graphite under the line, intro and end card. */
  graphite: '#1b1c1e',
};

/** WCAG's contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a, b) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The brand's colours in the lockup, by their part of the mark. */
const PARTS = {
  '#394648': 'leaf back',
  '#69995d': 'leaf signal',
  '#f8e9e9': 'spine',
};

/**
 * The lockup (`frontend/theme`, the version for dark backgrounds) with the mark's parts named
 * for the animation: the spine, the back leaf, the green leaf (the signal), and the word.
 */
export function animatedLogo(svg = readFileSync(LOCKUP_FILE, 'utf8')) {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
  const group = svg.match(/<g transform="([^"]+)">([\s\S]*?)<\/g>/);
  const word = svg.match(
    /<\/g>\s*<path fill="(#[0-9a-fA-F]{6})" transform="([^"]+)" d="([^"]+)"\s*\/>/,
  );
  if (!viewBox || !group || !word) {
    throw new Error(`${LOCKUP_FILE}: not the lockup the cards know`);
  }
  const paths = [
    ...group[2].matchAll(/<path fill="(#[0-9a-fA-F]{6})" d="([^"]+)"\s*\/>/g),
  ].map(([, fill, d]) => {
    const part = PARTS[fill.toLowerCase()];
    if (!part) throw new Error(`${LOCKUP_FILE}: an unknown colour ${fill}`);
    return `<path class="${part}" fill="${fill}" d="${d}"/>`;
  });
  if (paths.length !== 3) throw new Error(`${LOCKUP_FILE}: not three parts`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${PRODUCT_NAME}"><g transform="${group[1]}">${paths.join('')}</g><path class="word" fill="${word[1]}" transform="${word[2]}" d="${word[3]}"/></svg>`;
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** The mark's middle on the card, where the manuals fold back to (the logo at 660,400, 600 wide). */
const MARK_CENTER = { x: 713, y: 457 };

/**
 * The three manuals of the intro, each as its page in the take's language with the page in the
 * other language behind it.
 */
function manuals(texts, lang) {
  const [front, back] = lang === 'de' ? ['de', 'en'] : ['en', 'de'];
  const bars = (widths) =>
    `<div class="bars">${widths.map((w) => `<i style="--w: ${w}px"></i>`).join('')}</div>`;
  return texts.manuals
    .map((title, i) => {
      const center = 560 + i * 400;
      const page = (pageLang, place) =>
        `<div class="page ${place}"><div class="title">${escapeHtml(title)}</div><span class="lang">${pageLang.toUpperCase()}</span><div class="rule"></div>${bars([170, 120])}<div class="inset"><b>${escapeHtml(texts.module)}</b>${bars([150, 120, 170, 100])}</div></div>`;
      const style = [
        `left: ${center - 165}px`,
        `--dx: ${960 - center}px`,
        `--gx: ${MARK_CENTER.x - center}px`,
        `--gy: ${MARK_CENTER.y - 510}px`,
        `--at: ${(1.55 + i * 0.1).toFixed(2)}s`,
        `--back: ${(2.85 + i * 0.05).toFixed(2)}s`,
      ].join('; ');
      return `<div class="manual" style="${style}">${page(back, 'back')}${page(front, 'front')}</div>`;
    })
    .join('');
}

/** A card's page in a language: its template with every slot filled. */
export function cardPage(card, lang) {
  if (!Object.hasOwn(CARDS, card)) throw new Error(`no card ${card}`);
  const texts = CARD_TEXTS[lang];
  if (!texts) throw new Error(`no card texts in ${lang}`);
  const slots = {
    lang,
    ...CARD_COLORS,
    product: escapeHtml(PRODUCT_NAME),
    fonts: fontFaces(),
    background: LOOK.background,
    grain: GRAIN_SVG,
    logo: animatedLogo(),
    manuals: manuals(texts, lang),
    id: MODULE_ID,
    module: escapeHtml(texts.module),
    first: escapeHtml(texts.first),
    second: escapeHtml(texts.second),
  };
  const template = readFileSync(
    join(import.meta.dirname, `${card}.html`),
    'utf8',
  );
  return template.replace(/\{\{(\w+)\}\}/g, (slot, name) => {
    if (!Object.hasOwn(slots, name))
      throw new Error(`${card}: no slot ${slot}`);
    return slots[name];
  });
}
