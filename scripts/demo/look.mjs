// The films' approved look as numbers (#441, `docs/demo-videos.md`, "The shared look"): the
// frame every video and still uses, and the caption under the window in the tab videos. One
// place, read by the stills, the cards and the assembly.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

/**
 * The frame: the recording (1728×972) scaled into a rounded window on the graphite. The window
 * sits 48 px from the top, so 96 px stay below it for the caption: the skill's 72 px are too
 * little for a caption still readable at the landing page's size (see the doc). The hero uses
 * the same frame, without a caption.
 */
export const LOOK = {
  frame: { width: 1920, height: 1080 },
  recording: { width: 1728, height: 972 },
  window: { x: 128, y: 48, width: 1664, height: 936, radius: 22 },
  background:
    'radial-gradient(120% 90% at 50% 0%, #2a2c31 0%, #17181b 48%, #0b0c0e 100%)',
  shadow:
    '0 40px 90px rgba(0,0,0,.55), 0 8px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06)',
  grain: 0.05,
};

/**
 * A tab video loops: its last half second is blended into its opening, and the video starts half
 * a second in, so the end runs into the start without a jump.
 */
export const LOOP = { blend: 0.5 };

/** The grain on the graphite (under the window, as in the films) and the cards: fractal noise, grey, at 5 %. */
export const GRAIN_SVG = `<svg style="position:absolute;inset:0;opacity:${LOOK.grain};pointer-events:none" width="${LOOK.frame.width}" height="${LOOK.frame.height}"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="3"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#g)"/></svg>`;

/**
 * The caption of a tab video: one short sentence per shot, centred under the window on the
 * graphite, in the take's language.
 */
export const CAPTION = {
  font: 'Geist',
  weight: 500,
  size: 32,
  lineHeight: 40,
  letterSpacing: '-0.01em',
  /** The theme's dark-mode text colour: about 17:1 on the graphite below the window. */
  color: '#eef0ec',
  /** The middle of the 96 px band under the window. */
  centerY:
    LOOK.window.y +
    LOOK.window.height +
    (LOOK.frame.height - LOOK.window.y - LOOK.window.height) / 2,
  /** One line, never wider than the window less 128 px on each side. */
  maxWidth: LOOK.window.width - 256,
  maxLength: 70,
  /** Opacity only, no movement: in over the shot's first 0.25 s, out over its last. */
  fade: 0.25,
  /** A shot with a caption lasts at least this long, so it can be read. */
  minSeconds: 1.5,
};

/** The theme's fonts (`frontend/theme`): the films use the product's own type. */
export const FONT_FILES = {
  Geist: join(ROOT, 'frontend/theme/src/fonts/Geist-Variable.woff2'),
  'Geist Mono': join(ROOT, 'frontend/theme/src/fonts/GeistMono-Variable.woff2'),
};

/** `@font-face` rules for the theme's fonts, embedded, so a page works from anywhere. */
export function fontFaces(families = Object.keys(FONT_FILES)) {
  return families
    .map(
      (family) =>
        `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${readFileSync(FONT_FILES[family]).toString('base64')}) format('woff2');font-weight:100 900;font-display:block}`,
    )
    .join('');
}

/** The brand's horizontal lockup for dark backgrounds (`frontend/theme`, the owner's master). */
export const LOCKUP_FILE = join(
  ROOT,
  'frontend/theme/src/brand/openfolia-lockup-horizontal-color-dark.svg',
);

/** The frame around a screenshot (a PNG as base64), as an HTML page of the frame's size. */
export function framePage(png, caption) {
  const { frame, window: w } = LOOK;
  return `<!doctype html><html><head><meta charset="utf-8">${caption === undefined ? '' : `<style>${fontFaces([CAPTION.font])}</style>`}</head><body style="margin:0;width:${frame.width}px;height:${frame.height}px;overflow:hidden;position:relative;background:${LOOK.background}">
${GRAIN_SVG}
<img src="data:image/png;base64,${png}" style="position:absolute;left:${w.x}px;top:${w.y}px;width:${w.width}px;height:${w.height}px;border-radius:${w.radius}px;box-shadow:${LOOK.shadow}">
${caption === undefined ? '' : captionElement(caption)}
</body></html>`;
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/** The caption as an element of a frame-sized page: its text, centred under the window. */
export function captionElement(text) {
  const c = CAPTION;
  const top = c.centerY - c.lineHeight / 2;
  return `<p style="position:absolute;left:0;right:0;top:${top}px;margin:0;text-align:center;white-space:nowrap;font-family:'${c.font}',sans-serif;font-weight:${c.weight};font-size:${c.size}px;line-height:${c.lineHeight}px;letter-spacing:${c.letterSpacing};color:${c.color}">${escapeHtml(text)}</p>`;
}

/** A caption alone on a transparent page of the frame's size: the overlay the assembly uses. */
export function captionPage(text) {
  const { frame } = LOOK;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces([CAPTION.font])}html,body{background:transparent}</style></head><body style="margin:0;width:${frame.width}px;height:${frame.height}px;overflow:hidden;position:relative">${captionElement(text)}</body></html>`;
}
