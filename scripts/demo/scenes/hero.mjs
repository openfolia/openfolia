// The hero's take (#804, storyboard in `hero.md` next to this file): one story, a circle. A reader
// asks the portal how tight the wheel bolts go, and neither the portal nor an AI assistant has the
// answer (release 1.1); the gap is in every manual, variant and language; in OpenFolia the fix goes
// in once: Mira adds the torque to the module in both languages, the French goes to its
// translators, Jonas approves, Ada releases 1.2; and the same question finds its answer in every
// PDF, on the portal and through the assistant. Filmed on the demo (`pnpm demo:start`), in one
// language and theme per run:
//
//   node scripts/demo/scenes/hero.mjs --lang en|de [--theme light|dark] [--no-reset]
//
// `--no-reset` films on the running demo as it is: only on one no take has used yet (a take
// makes release 1.2).
//
// It resets the demo first (a clean state, every take), records the parts of `HERO_PARTS` with the
// recording kit (`record.mjs`, `Take`) and joins them into `.demo/takes/hero[-dark]-<lang>.webm`
// and `.json`, which `assemble.mjs hero[-dark] --lang <lang>` puts between the cards. What
// happens between the parts (the save points, the review's merge, the French import, the
// release's files, the portal built again) is done through the API, off camera: the cuts hide
// only the waiting. The portal is a real build (`frontend/portal`) and the assistant's passage a
// real `search` through the MCP server (`backend/mcp`), both read with a service account of the
// owners' audience (`outlets.mjs`).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CARD_COLORS, CARD_TEXTS } from '../cards/cards.mjs';
import { LOOK } from '../look.mjs';
import { narrationPlan } from '../narration.mjs';
import {
  askAssistant,
  assistantLayer,
  buildOutlets,
  buildPortal,
  outletsLayer,
  readerToken,
  servePortal,
  withAssistant,
} from '../outlets.mjs';
import { DEMO_DIR, STATE_FILE } from '../paths.mjs';
import { DEMO_PEOPLE } from '../people.mjs';
import { chromium } from '../playwright.mjs';
import { Client, waitForOutputs } from '../populate.mjs';
import { joinParts, Take } from '../record.mjs';

export const HERO_LANGS = ['en', 'de'];
export const HERO_THEMES = ['light', 'dark'];
const MODULE = 'changing-a-wheel';
const STEP = 'step-lower';
const REVISION = '1.2';

/**
 * The words the take adds to the last step, per language: where the caret goes (characters
 * back from the step's end) and what is typed there. `after` is the step as it reads then.
 */
export const HERO_EDIT = {
  en: {
    before: 'Lower the vehicle and tighten the wheel bolts crosswise.',
    back: 1,
    typed: ' to 120 Nm',
    after: 'Lower the vehicle and tighten the wheel bolts crosswise to 120 Nm.',
  },
  de: {
    before:
      'Lassen Sie das Fahrzeug ab und ziehen Sie die Radschrauben über Kreuz fest.',
    back: 5,
    typed: 'mit 120 Nm ',
    after:
      'Lassen Sie das Fahrzeug ab und ziehen Sie die Radschrauben über Kreuz mit 120 Nm fest.',
  },
};

/** The new words, as the PDFs set them: what the take highlights in each file. */
export const HIGHLIGHT = ['120', 'Nm'];

/** The texts the take writes through the API, in its language (the release notes in both). */
export const HERO_TEXTS = {
  en: {
    changeSet: 'Tightening torque for the wheel bolts',
    notes: 'Changing a wheel: the tightening torque for the wheel bolts.',
  },
  de: {
    changeSet: 'Anzugsmoment der Radschrauben',
    notes: 'Rad wechseln: das Anzugsmoment der Radschrauben.',
  },
};

/**
 * The files the last shot shows: two manuals in two variants, each in the take's language first,
 * then the other one. `model` is the variant's model name, as the manuals' attributes have it.
 */
export const HERO_FILES = [
  {
    manual: 'owners',
    title: 0,
    variant: 'body=estate,drive=electric,market=eu',
    model: 'Fenna Estate',
  },
  {
    manual: 'quick-start',
    title: 1,
    variant: 'body=hatchback,drive=electric,market=uk',
    model: 'Fenna Hatchback',
  },
];

/** The step as the edit leaves it typed: `before` with `typed` put `back` characters from its end. */
export function editedStep({ before, back, typed }) {
  return (
    before.slice(0, before.length - back) +
    typed +
    before.slice(before.length - back)
  );
}

/**
 * How long each shot holds at least, in milliseconds: what its actions need at the look's pacing
 * (one action, then its result). A longer line of the voice-over makes its shot longer.
 */
export const HERO_SHOTS = {
  '01a': 5000,
  '01b': 2500,
  '01c': 4500,
  '02a': 5000,
  '02b': 4000,
  '02c': 6600,
  '03a': 2400,
  '03b': 4800,
  '03c': 3600,
  '03d': 5500,
  '03e': 3400,
  '04a': 6500,
  '05a': 7800,
  '05b': 4400,
  '06a': 6200,
  '06b': 5500,
  '06c': 5000,
  '07a': 3500,
};

/**
 * Each shot's length: its hold (`HERO_SHOTS`) or its line of the voice-over with the lead and
 * tail (`narrationPlan`: the voice's length once it exists, an estimate before), the longer.
 */
export function heroPlan(narration, holds = HERO_SHOTS) {
  const ids = narration.shots.map((shot) => shot.id);
  const missing = Object.keys(holds).filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !(id in holds));
  if (missing.length || extra.length) {
    throw new Error(
      `the hero's narration and shots differ: ${[...missing, ...extra]}`,
    );
  }
  return narration.shots.map((shot) => ({
    id: shot.id,
    ms: Math.max(holds[shot.id], shot.ms),
    spokenMs: shot.spokenMs,
    voiced: Boolean(shot.voice),
  }));
}

/**
 * The words of a PDF page (`pdftotext -bbox`'s XHTML): each with its box in points.
 */
export function pageWords(xhtml) {
  return [
    ...xhtml.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g,
    ),
  ].map(([, x0, y0, x1, y1, text]) => ({
    text,
    x0: Number(x0),
    y0: Number(y0),
    x1: Number(x1),
    y1: Number(y1),
  }));
}

/**
 * The box around `phrase` (its words in a row on one line, punctuation after a word ignored), or
 * null when the page does not have it.
 */
export function phraseBox(words, phrase = HIGHLIGHT) {
  const bare = (text) => text.replace(/[.,;:]+$/, '');
  for (let i = 0; i + phrase.length <= words.length; i++) {
    const run = words.slice(i, i + phrase.length);
    if (!run.every((word, k) => bare(word.text) === phrase[k])) continue;
    if (run.some((word) => Math.abs(word.y0 - run[0].y0) > 2)) continue;
    return {
      x0: run[0].x0,
      y0: Math.min(...run.map((w) => w.y0)),
      x1: run.at(-1).x1,
      y1: Math.max(...run.map((w) => w.y1)),
    };
  }
  return null;
}

/**
 * The part of the page a tile shows, in points: the text column with its step numbers, from two
 * steps above the new words to just below their line, so the step reads with its neighbours.
 */
export function cropAround(box, page = { width: 595.276 }) {
  const margin = 54;
  const y = Math.max(0, box.y0 - 50);
  return {
    x: margin,
    y,
    width: page.width - 2 * margin,
    height: box.y1 + 12 - y,
  };
}

const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );

/**
 * The last shot's layer: the four files as tiles on a dark scrim, the take's language on the top
 * row, each tile a strip of its page around the new words, which a highlight then marks. `tiles`
 * hold the page picture (a data URL), its crop and the highlight's box, both in points.
 */
export function outputsLayer(
  tiles,
  { tileWidth = 760, dpi = 200, columns = 2 } = {},
) {
  const pt = dpi / 72;
  // The page picture is wider than its tile: \`max-width: none\`, or the app's own image rule
  // would shrink it to the tile and show another part of the page.
  const html = tiles
    .map((tile, i) => {
      const scale = tileWidth / (tile.crop.width * pt);
      const height = Math.round(tile.crop.height * pt * scale);
      const mark = {
        left: (tile.box.x0 - tile.crop.x) * pt * scale - 4,
        top: (tile.box.y0 - tile.crop.y) * pt * scale - 3,
        width: (tile.box.x1 - tile.box.x0) * pt * scale + 8,
        height: (tile.box.y1 - tile.box.y0) * pt * scale + 6,
      };
      const delay = 500 + i * 220;
      return `<figure style="margin:0;display:flex;flex-direction:column;gap:10px;animation:demo-tile 420ms cubic-bezier(.22,.9,.3,1) ${i * 120}ms both">
  <figcaption style="font:500 17px/1.2 Geist,system-ui,sans-serif;color:#eef0ec;display:flex;gap:10px;align-items:baseline">${escapeHtml(tile.label)}<span style="font:500 14px 'Geist Mono',ui-monospace,monospace;color:${CARD_COLORS.muted}">${escapeHtml(tile.lang.toUpperCase())}</span></figcaption>
  <div style="position:relative;width:${tileWidth}px;height:${height}px;overflow:hidden;border-radius:10px;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.45)">
    <img src="${tile.picture}" style="position:absolute;left:${-tile.crop.x * pt * scale}px;top:${-tile.crop.y * pt * scale}px;width:${tile.pageWidth * pt * scale}px;max-width:none;height:auto" alt="">
    <i style="position:absolute;left:${mark.left.toFixed(1)}px;top:${mark.top.toFixed(1)}px;width:${mark.width.toFixed(1)}px;height:${mark.height.toFixed(1)}px;border-radius:5px;background:rgba(105,153,93,.32);box-shadow:inset 0 -3px 0 #69995d;transform-origin:0 50%;animation:demo-mark 520ms cubic-bezier(.65,0,.25,1) ${delay}ms both"></i>
  </div>
</figure>`;
    })
    .join('');
  return `<style>
@keyframes demo-tile { from { opacity: 0; transform: translateY(12px); filter: blur(6px) } to { opacity: 1; transform: none; filter: none } }
@keyframes demo-mark { from { transform: scaleX(0) } to { transform: scaleX(1) } }
</style>
<div style="position:absolute;inset:0;background:rgba(14,15,17,.9);display:grid;place-content:center;grid-template-columns:repeat(${columns},${tileWidth}px);gap:44px 40px">${html}</div>`;
}

const run = (file, args, options = {}) =>
  execFileSync(file, args, { encoding: 'utf8', ...options });

/**
 * One PDF of the release, downloaded, and a tile of it for `outputsLayer`: the first page that has
 * `phrase` (its words, punctuation after a word left out), cropped by `crop` around the phrase's
 * box, which the tile marks.
 */
export async function pdfTile(
  admin,
  release,
  file,
  lang,
  dir,
  { phrase = HIGHLIGHT, crop = cropAround } = {},
) {
  const { data } = await admin.get(
    `/releases/${release}/outputs?page[size]=100`,
  );
  const output = data.find(
    (o) =>
      o.attributes.kind === 'pdf' &&
      o.attributes.manual === file.manual &&
      o.attributes.variant === file.variant &&
      o.attributes.lang === lang,
  );
  if (!output) throw new Error(`no ${file.manual} ${file.variant} ${lang} PDF`);
  const response = await fetch(`${admin.apiUrl}${output.links.file}`, {
    headers: {
      Authorization: `Bearer ${admin.token}`,
      'X-Ccms-User': admin.person.id,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${output.links.file}: ${response.status}`);
  const pdf = join(dir, `${file.manual}-${lang}.pdf`);
  writeFileSync(pdf, Buffer.from(await response.arrayBuffer()));
  const pages = Number(/Pages:\s+(\d+)/.exec(run('pdfinfo', [pdf]))?.[1]);
  for (let page = 1; page <= pages; page++) {
    const words = pageWords(
      run('pdftotext', [
        '-bbox',
        '-f',
        String(page),
        '-l',
        String(page),
        pdf,
        '-',
      ]),
    );
    const box = phraseBox(words, phrase);
    if (!box) continue;
    const prefix = join(dir, `${file.manual}-${lang}-p${page}`);
    run('pdftoppm', [
      ...['-r', '200', '-png', '-singlefile'],
      ...['-f', String(page), '-l', String(page), pdf, prefix],
    ]);
    const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(run('pdfinfo', [pdf]));
    const pageWidth = Number(size?.[1] ?? 595.276);
    return {
      label: `${CARD_TEXTS[lang].manuals[file.title]} · ${file.model}`,
      lang,
      picture: `data:image/png;base64,${readFileSync(`${prefix}.png`).toString('base64')}`,
      pageWidth,
      crop: crop(box, { width: pageWidth }),
      box,
    };
  }
  throw new Error(`${pdf}: no page has "${phrase.join(' ')}"`);
}

/**
 * The take's parts, in order: who films each (a page of the editor as one of the demo people, or
 * the reader portal at a release) and its shots. Between two parts, off camera, the API does what
 * only waits: the save points, the review's merge, the French translation coming back, the
 * release's files, the portal built again.
 */
export const HERO_PARTS = [
  { name: 'portal-1.1', portal: true, shots: ['01a', '01b', '01c'] },
  { name: 'files-1.1', user: 'author', shots: ['02a'] },
  { name: 'content', user: 'author', shots: ['02b'] },
  { name: 'builder', user: 'author', shots: ['02c'] },
  { name: 'module', user: 'author', shots: ['03a', '03b', '03c', '03d'] },
  { name: 'languages', user: 'author', shots: ['03e'] },
  { name: 'review', user: 'reviewer', shots: ['04a'] },
  { name: 'release', user: 'admin', shots: ['05a'] },
  { name: 'files-1.2', user: 'admin', shots: ['05b', '06a'] },
  { name: 'portal-1.2', portal: true, shots: ['06b', '06c', '07a'] },
];

/** The words the reader types into the portal's search, and the step they look for. */
export const PORTAL_SEARCH = {
  en: { query: 'wheel bolts', result: 'Changing a wheel', step: 'crosswise' },
  de: { query: 'Radschrauben', result: 'Rad wechseln', step: 'über Kreuz' },
};

/** The new words as the portal and the assistant show them. */
export const NEW_WORDS = '120 Nm';

/** The French step as its translators send it back (off camera, through an XLIFF import). */
export const FRENCH_STEP =
  'Descendez le véhicule et serrez les boulons en croix à 120 Nm.';

/** The editor's words the take finds its way by, per language. */
const UI = {
  en: { estate: 'Estate · Electric', electric: 'Drive: Electric' },
  de: { estate: 'Kombi · Elektro', electric: 'Antrieb: Elektro' },
};

/** The high-voltage module, as the preview lists it in either language. */
const HIGH_VOLTAGE = /^(High-voltage system|Hochvoltsystem)$/;

/** The XLIFF of a translation job with `target` as each unit's translation. */
export function translatedXliff(xliff, target) {
  let units = 0;
  const out = xliff.replace(/<\/source>(\s*)<\/segment>/g, (_, space) => {
    units += 1;
    return `</source>${space}<target>${escapeXml(target)}</target>${space}</segment>`;
  });
  if (units !== 1) throw new Error(`the French job has ${units} units, not 1`);
  return out;
}

const escapeXml = (text) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

export function parseHero(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      lang: { type: 'string' },
      theme: { type: 'string', default: 'light' },
      'no-reset': { type: 'boolean' },
    },
  });
  if (!HERO_LANGS.includes(values.lang))
    throw new Error(`--lang: one of ${HERO_LANGS}`);
  if (!HERO_THEMES.includes(values.theme))
    throw new Error(`--theme: one of ${HERO_THEMES}`);
  return {
    lang: values.lang,
    theme: values.theme,
    reset: !values['no-reset'],
    name: `${values.theme === 'dark' ? 'hero-dark' : 'hero'}-${values.lang}`,
  };
}

/** Where the words go in a step: the left edge of the character `back` from its end. */
function insertAt(step, back) {
  return step.first().evaluate((element, from) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const last = nodes.at(-1);
    const range = document.createRange();
    const at = Math.max(0, last.length - from);
    range.setStart(last, at);
    range.setEnd(last, Math.min(last.length, at + 1));
    const rect = range.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return {
      x: rect.left - box.left + 1,
      y: rect.top - box.top + rect.height / 2,
    };
  }, back);
}

/** Scrolls with the wheel, in small eased steps, until `target`'s middle is near `y`. */
async function scrollTo(take, target, y, { steps = 14 } = {}) {
  const box = await target.first().boundingBox();
  if (!box) return;
  const distance = box.y + box.height / 2 - y;
  if (Math.abs(distance) < 20) return;
  for (let i = 0; i < steps; i++) {
    await take.page.mouse.wheel(0, distance / steps);
    await take.pause(24);
  }
  await take.pause(250);
}

/**
 * Marks `phrase` inside `scope` on the page with the brand green, drawn left to right (as the
 * PDF tiles mark theirs); `animate` false draws it at once (for a still).
 */
function markOnPage(page, scope, phrase, animate = true) {
  return scope.first().evaluate(
    (element, [words, play]) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const at = node.data.indexOf(words);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + words.length);
        const r = range.getBoundingClientRect();
        const style = document.createElement('style');
        style.textContent =
          '@keyframes demo-page-mark { from { transform: scaleX(0) } to { transform: scaleX(1) } }';
        document.head.appendChild(style);
        const mark = document.createElement('i');
        mark.style.cssText = `position:absolute;left:${r.left + scrollX - 4}px;top:${r.top + scrollY - 2}px;width:${r.width + 8}px;height:${r.height + 4}px;border-radius:5px;background:rgba(105,153,93,.32);box-shadow:inset 0 -3px 0 #69995d;transform-origin:0 50%;pointer-events:none;z-index:5;${play ? 'animation:demo-page-mark 520ms cubic-bezier(.65,0,.25,1) both' : ''}`;
        document.body.appendChild(mark);
        return true;
      }
      return false;
    },
    [phrase, animate],
  );
}

/**
 * The portal's moves, the same on both releases so the two shots rhyme: the start page, the
 * search for the reader's words, the result opened on its step. Resolves to the step.
 */
async function portalSearch(take, lang) {
  const { page } = take;
  const words = PORTAL_SEARCH[lang];
  const field = page.locator('main').getByRole('searchbox').first();
  await take.click(field, {
    at: { x: 0.3, y: 0.5 },
    duration: 550,
    after: 150,
  });
  await take.type(words.query);
  await take.pause(250);
  await page.keyboard.press('Enter');
  const result = page.locator('main a', { hasText: words.result }).first();
  await result.waitFor({ timeout: 15_000 });
  await take.pause(500);
  await take.click(result, { at: { x: 0.2, y: 0.5 }, duration: 500, after: 0 });
  await page.waitForURL(/#/);
  const step = page.locator('main li', { hasText: words.step }).last();
  await step.waitFor({ timeout: 10_000 });
  await take.pause(350);
  await scrollTo(take, step, 560);
  return step;
}

/** A portal page of its own, off camera: the step marked, and a picture of it for 07a. */
async function portalPicture(browser, { url, lang, theme }) {
  const context = await browser.newContext({
    viewport: LOOK.recording,
    deviceScaleFactor: 2,
    colorScheme: theme,
    bypassCSP: true,
  });
  try {
    const page = await context.newPage();
    const words = PORTAL_SEARCH[lang];
    await page.goto(
      `${url}/${lang}/search/?q=${encodeURIComponent(words.query)}`,
    );
    const result = page.locator('main a', { hasText: words.result }).first();
    await result.click();
    await page.waitForURL(/#/);
    const step = page.locator('main li', { hasText: words.step }).last();
    await step.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    if (!(await markOnPage(page, step, NEW_WORDS, false))) {
      throw new Error(`the portal's step has no "${NEW_WORDS}"`);
    }
    const before = page.locator('main li', { hasText: words.step }).last();
    const box = await before.boundingBox();
    const clip = {
      x: box.x - 56,
      y: box.y - 14,
      width: Math.min(760, LOOK.recording.width - box.x + 56),
      // The item's box has its spacing below the text: the strip ends just under the words.
      height: box.height + 14,
    };
    const png = await page.screenshot({ clip });
    return {
      src: `data:image/png;base64,${png.toString('base64')}`,
      width: clip.width,
      height: clip.height,
    };
  } finally {
    await context.close();
  }
}

/**
 * Off camera: the French comes back. A translation job for the module's outdated French unit,
 * its XLIFF translated (`FRENCH_STEP`), imported and applied (a change set of the importer's),
 * then reviewed and merged, so the French is current again and every check of the release
 * passes.
 */
async function frenchBack(admin, reviewer) {
  const { data: job } = await admin.post(
    '/translations/exports',
    {
      data: {
        type: 'TranslationJob',
        attributes: {
          languages: ['fr'],
          subject: { type: 'modules', moduleIds: [MODULE] },
        },
      },
    },
    [201],
  );
  const headers = {
    Authorization: `Bearer ${admin.token}`,
    'X-Ccms-User': admin.person.id,
  };
  const file = await fetch(
    `${admin.apiUrl}/translations/exports/${job.id}/file?lang=fr`,
    { headers, signal: AbortSignal.timeout(60_000) },
  );
  if (!file.ok) throw new Error(`the French job's file: ${file.status}`);
  const form = new FormData();
  form.append(
    'file',
    new Blob([translatedXliff(await file.text(), FRENCH_STEP)], {
      type: 'application/xliff+xml',
    }),
    `translation-${job.id}-fr.xlf`,
  );
  const upload = await fetch(`${admin.apiUrl}/translations/imports`, {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'application/vnd.api+json',
      'X-Ccms-Request': '1',
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const imported = await upload.json();
  if (upload.status !== 201) {
    throw new Error(
      `the French import: ${JSON.stringify(imported).slice(0, 400)}`,
    );
  }
  const { data: applied } = await admin.post(
    `/translations/imports/${imported.data.id}/apply`,
    undefined,
    [200, 201],
  );
  const set = applied.relationships?.changeSet?.data?.id;
  if (!set) throw new Error('the French import made no change set');
  await admin.transition(set, 'submit', TRANSLATION_BACK);
  await reviewer.transition(set, 'approve');
  await admin.transition(set, 'merge');
}

/** The note on the French change set's way through review (off camera). */
const TRANSLATION_BACK = 'French: the tightening torque';

/** The id of the release with `revision`, from the API. */
async function releaseId(admin, revision) {
  const { data } = await admin.get('/releases?page[size]=100');
  const found = data.find((r) => r.attributes.revision === revision);
  if (!found) throw new Error(`no release ${revision} was created`);
  return found.id;
}

/**
 * A role that lets Mira mark the German current with its source, as a team gives the person who
 * writes both languages: `translation.manage` for German only. Made for the take (the demo is
 * reset before the next).
 */
async function germanTranslator(admin) {
  const { data: roles } = await admin.get('/roles?page[size]=100');
  if (roles.some((role) => role.id === 'demo-translator-de')) return;
  await admin.post('/roles', {
    data: {
      type: 'Role',
      id: 'demo-translator-de',
      attributes: {
        name: 'German translation',
        permissions: ['translation.manage'],
        scope: { languages: ['de'] },
      },
    },
  });
  await admin.post(
    `/users/${DEMO_PEOPLE.author.id}/relationships/roles`,
    { data: [{ type: 'Role', id: 'demo-translator-de' }] },
    [200, 201],
  );
}

/**
 * Puts the caret `back` characters before the end of `step`'s text, through the page's own
 * selection (the editor follows it). Not End and arrow keys: End goes to the end of the visual
 * line, so a wrapped step put the new words in the wrong place.
 */
async function caretFromEnd(take, step, back) {
  await step.first().evaluate((element, count) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let left = count;
    for (const node of nodes.reverse()) {
      if (left <= node.data.length) {
        const range = document.createRange();
        range.setStart(node, node.data.length - left);
        range.collapse(true);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      left -= node.data.length;
    }
    throw new Error('the step is shorter than the caret');
  }, back);
  await take.pause(80);
}

/** The end of the edited step as the working copy must hold it: the new words in their place. */
export function editedTail(edit) {
  return edit.after.slice(-(edit.typed.trim().length + edit.back + 12));
}

/** Waits until the change set's working copy of the module in `lang` reads `text`. */
async function waitForWorkingCopy(client, changeSet, lang, text) {
  const path = `/change-sets/${changeSet}/modules/${lang}/${MODULE}/working-copy`;
  for (let i = 0; i < 40; i++) {
    const { data } = await client.get(path);
    if (JSON.stringify(data.attributes.content).includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the ${lang} working copy does not have "${text}"`);
}

async function main() {
  const { lang, theme, reset, name } = parseHero(process.argv.slice(2));
  const other = lang === 'en' ? 'de' : 'en';
  const texts = HERO_TEXTS[lang];
  if (reset) {
    run(
      process.execPath,
      [
        join(import.meta.dirname, '..', 'demo.mjs'),
        ...['reset', '--lang', lang, '--theme', theme],
        ...['--user', 'author', '--no-build'],
      ],
      { stdio: 'inherit' },
    );
  }
  // What the portal and the assistant run on, built before anything else (Nx caches it).
  buildOutlets();
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (state.options.lang !== lang) {
    throw new Error(
      `the demo runs in ${state.options.lang}: leave out --no-reset`,
    );
  }
  const admin = new Client(state.apiUrl, state.token, DEMO_PEOPLE.admin);
  const author = new Client(state.apiUrl, state.token, DEMO_PEOPLE.author);
  const reviewer = new Client(state.apiUrl, state.token, DEMO_PEOPLE.reviewer);
  // Each shot as long as its actions need, or its line of the voice-over, whichever is longer.
  // The voice is the light cut's: the dark one says the same.
  const plan = heroPlan(narrationPlan('hero', lang));
  const ms = Object.fromEntries(plan.map((shot) => [shot.id, shot.ms]));
  for (const shot of plan) {
    console.log(
      `${shot.id}: ${shot.ms} ms (line ${shot.spokenMs} ms, ${shot.voiced ? 'voice' : 'estimated'})`,
    );
  }
  const work = join(DEMO_DIR, 'takes', 'work', name);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });

  // Off camera, first: the demo's revision in review holds the module's lock, so it is set
  // aside (the demo is reset before the next take); the portal at release 1.1 and the
  // assistant's answer there, both read by a service account of the owners' audience.
  const { data: open } = await admin.get('/change-sets?page[size]=100');
  const people = Object.values(DEMO_PEOPLE);
  for (const set of open) {
    if (!['draft', 'in-review'].includes(set.attributes.state)) continue;
    // Only its author may abandon a change set.
    const owner = people.find((p) => p.id === set.attributes.author?.id);
    if (!owner)
      throw new Error(`change set ${set.id}: no demo person started it`);
    await new Client(state.apiUrl, state.token, owner).transition(
      set.id,
      'abandon',
    );
  }
  await germanTranslator(admin);
  const token = await readerToken(admin);
  const reader = { apiUrl: state.apiUrl, token };
  const [release11] = state.made.releases.slice(-1);
  const portalDir = (revision) =>
    join(DEMO_DIR, 'portal', `${name}-${revision}`);
  await buildPortal({
    ...reader,
    lang,
    release: release11,
    outDir: portalDir('1.1'),
  });
  const before = await withAssistant(reader, (call) =>
    askAssistant(call, { lang, revision: '1.1' }),
  );
  if (before.found.excerpt.includes(NEW_WORDS)) {
    throw new Error('release 1.1 already has the new words');
  }
  const changeSet = await author.changeSet(texts.changeSet);

  const browser = await chromium.launch();
  const parts = [];
  let portal = await servePortal(portalDir('1.1'));
  const take = (part, where) =>
    Take.start(browser, {
      video: name,
      lang,
      theme,
      state,
      user: part.user,
      ...(part.portal ? { url: `${portal.url}/${lang}/` } : { path: where }),
    });
  const finish = async (part, t) =>
    parts.push(await t.finish({ name: `${name}.${part.name}` }));
  const P = Object.fromEntries(HERO_PARTS.map((p) => [p.name, p]));
  try {
    // 01: the reader's question, on the portal at release 1.1, and the assistant's gap.
    {
      const t = await take(P['portal-1.1']);
      await t.placeCursor(1100, 600);
      let step;
      await t.shot('01a', ms['01a'], async () => {
        step = await portalSearch(t, lang);
      });
      await t.shot('01b', ms['01b'], async () => {
        // Beside the step's end: nothing more to read.
        const end = await step.boundingBox();
        await t.move(end.x + end.width - 40, end.y + end.height + 22, {
          duration: 600,
        });
      });
      await t.shot('01c', ms['01c'], async () => {
        await t.hideCursor();
        await t.showLayer(
          assistantLayer(before.found, {
            lang,
            call: before.call,
            phrase: null,
          }),
          350,
        );
      });
      await finish(P['portal-1.1'], t);
      await portal.close();
    }

    // 02a: release 1.1's files, every manual per variant and language.
    {
      const t = await take(P['files-1.1'], `/releases/${release11}`);
      await t.placeCursor(1240, 300);
      const files = t.page.locator('of-release-files');
      await t.shot('02a', ms['02a'], async () => {
        await t.point(t.page.locator('[data-slot="files-progress"]'), {
          offset: { x: 60, y: 22 },
          duration: 600,
        });
        await t.pause(400);
        const box = await files.getByRole('table').boundingBox();
        await t.move(box.x + box.width * 0.35, box.y + 150, { duration: 600 });
        for (let i = 0; i < 18; i++) {
          await t.page.mouse.wheel(0, 22);
          await t.pause(30);
        }
      });
      await finish(P['files-1.1'], t);
    }

    // 02b: the modules, each written once, in its three languages.
    {
      const t = await take(P.content, '/content');
      await t.placeCursor(1240, 700);
      const row = t.page.getByRole('row').filter({ hasText: MODULE }).first();
      // The list loaded before the shot: no skeleton in the film.
      await row.waitFor({ timeout: 20_000 });
      await t.pause(300);
      await t.shot('02b', ms['02b'], async () => {
        const rows = t.page.getByRole('row');
        await t.point(rows.nth(1), { at: { x: 0.69, y: 0.85 }, duration: 600 });
        await t.point(rows.nth(4), { at: { x: 0.69, y: 0.85 }, duration: 700 });
        await t.point(row, { at: { x: 0.69, y: 0.8 }, duration: 600 });
      });
      await finish(P.content, t);
    }

    // 02c: the owner's manual, put together from modules; the preview switched to the electric
    // estate, where the high-voltage system appears.
    {
      // In the take's language: the builder's outputs, and so the preview it opens.
      const t = await take(P.builder, `/manuals/owners?lang=${lang}`);
      await t.placeCursor(1240, 600);
      const ui = UI[lang];
      await t.shot('02c', ms['02c'], async () => {
        // The module that only the electric cars get: its condition beside it.
        await t.point(t.page.getByText(ui.electric).first(), {
          at: { x: 0.5, y: 1.7 },
          duration: 500,
        });
        await t.click(
          t.page.getByRole('button', { name: /^(Preview|Vorschau)$/ }).first(),
          { duration: 500, after: 0 },
        );
        await t.page.waitForURL(/\/preview/);
        await t.settle(300);
        await t.click(
          t.page.getByRole('combobox', { name: /^(Variant|Variante)/ }).first(),
          { duration: 450, after: 300 },
        );
        await t.click(
          t.page.getByRole('option', { name: new RegExp(ui.estate) }).first(),
          { duration: 400, after: 500 },
        );
        await t.point(
          // The preview renders the manual in a frame of its own.
          t.page
            .locator('iframe')
            .first()
            .contentFrame()
            .getByRole('link', { name: HIGH_VOLTAGE })
            .first(),
          { at: { x: 1.15, y: 0.5 }, duration: 500 },
        );
      });
      await finish(P.builder, t);
    }

    // 03a–03d: Mira's change, once, in both languages.
    {
      const t = await take(
        P.module,
        `/content/${lang}/${MODULE}?cs=${changeSet}`,
      );
      const { page } = t;
      const step = page.locator(
        // The editor writes the block ID quoted into `data-id`: matched as a part.
        `[contenteditable="true"] [data-node="listItem"][data-id*='${STEP}'] [data-node="itemText"]`,
      );
      await step
        .first()
        .waitFor({ timeout: 20_000 })
        .catch(async (error) => {
          await page.screenshot({ path: join(work, 'problem-open.png') });
          throw error;
        });
      await t.placeCursor(980, 420);
      await t.shot('03a', ms['03a'], async () => {
        await t.move(860, 600, { duration: 200 });
        for (let i = 0; i < 10; i++) {
          await page.mouse.wheel(0, 26);
          await t.pause(30);
        }
        await t.pause(300);
        await t.point(step, {
          offset: await insertAt(step, HERO_EDIT[lang].back),
          duration: 420,
        });
      });
      await t.shot('03b', ms['03b'], async () => {
        await t.click(step, {
          offset: await insertAt(step, HERO_EDIT[lang].back),
          after: 250,
        });
        await caretFromEnd(t, step, HERO_EDIT[lang].back);
        await t.type(HERO_EDIT[lang].typed);
        const box = await step.first().boundingBox();
        await t.move(box.x + box.width * 0.75, box.y + 70, { duration: 240 });
      });
      const usedIn = page.locator('[aria-labelledby="module-used-title"]');
      await t.shot('03c', ms['03c'], async () => {
        await t.point(usedIn, { offset: { x: 60, y: 54 }, duration: 500 });
        await t.pause(500);
        await t.point(usedIn, { offset: { x: 60, y: 80 }, duration: 200 });
      });
      await waitForWorkingCopy(
        author,
        changeSet,
        lang,
        editedTail(HERO_EDIT[lang]),
      );
      await t.shot('03d', ms['03d'], async () => {
        await t.click(
          page.getByRole('link', { name: other.toUpperCase(), exact: true }),
          { duration: 500, after: 0 },
        );
        await page.waitForFunction(
          ([selector, words]) =>
            document.querySelector(selector)?.textContent?.includes(words),
          [
            `[contenteditable="true"] [data-node="listItem"][data-id*='${STEP}'] [data-node="itemText"]`,
            HERO_EDIT[other].before.slice(0, 20),
          ],
          { timeout: 15_000 },
        );
        // Not `settle`: the module page always shows a pulse, so it would wait out its timeout.
        await page
          .waitForFunction(
            () => [...document.images].every((image) => image.complete),
            undefined,
            { timeout: 5_000 },
          )
          .catch(() => undefined);
        await t.pause(200);
        await scrollTo(t, step, 560, { steps: 8 });
        await t.click(step, {
          offset: await insertAt(step, HERO_EDIT[other].back),
          duration: 500,
          after: 200,
        });
        await caretFromEnd(t, step, HERO_EDIT[other].back);
        await t.type(HERO_EDIT[other].typed);
        const box = await step.first().boundingBox();
        await t.move(box.x + box.width * 0.75, box.y + 70, { duration: 240 });
      });
      await waitForWorkingCopy(
        author,
        changeSet,
        other,
        editedTail(HERO_EDIT[other]),
      );
      // Time for the autosave (the part is cut after its last shot, so this is not filmed).
      await t.pause(1_500);
      await finish(P.module, t);
    }

    // Off camera: the save point; the German marked current with the English it now matches.
    await author.savePoint(changeSet);
    await author.markCurrent(changeSet, MODULE, 'de');

    // 03e: the languages in the change: the German current, the French out of date.
    {
      const t = await take(P.languages, `/content?cs=${changeSet}`);
      await t.placeCursor(1240, 700);
      const row = t.page.getByRole('row').filter({ hasText: MODULE }).first();
      await row.waitFor({ timeout: 20_000 });
      await t.pause(300);
      await t.shot('03e', ms['03e'], async () => {
        await t.point(row, { at: { x: 0.63, y: 0.85 }, duration: 700 });
        await t.pause(300);
        await t.point(row, { at: { x: 0.71, y: 0.85 }, duration: 400 });
      });
      await finish(P.languages, t);
    }

    // Off camera: Mira asks for review.
    await author.transition(changeSet, 'submit', texts.changeSet);

    // 04a: Jonas reads what changed, word by word, and approves.
    {
      const t = await take(P.review, '/review');
      await t.placeCursor(1180, 880);
      const { page } = t;
      const approve = page.getByRole('button', {
        name: REVIEW_UI[lang].approve,
        exact: true,
      });
      const approvals = page.getByRole('region', {
        name: REVIEW_UI[lang].approvals,
        exact: true,
      });
      await t.shot('04a', ms['04a'], async () => {
        await t.pause(400);
        await t.point(page.locator('ins').first(), {
          duration: 800,
          at: { x: 0.3, y: 1.6 },
        });
        await t.pause(900);
        await t.click(approve, { after: 400, duration: 600 });
        await t.point(approvals.getByRole('listitem').last(), {
          duration: 600,
          at: { x: 0.85, y: 1.6 },
        });
      });
      await finish(P.review, t);
    }

    // Off camera: the change merged; the French comes back from its translators.
    await admin.transition(changeSet, 'merge');
    await frenchBack(admin, reviewer);

    // 05a: Ada creates release 1.2: every check passes.
    let release;
    {
      const t = await take(P.release, '/releases');
      await t.placeCursor(1240, 300);
      const { page } = t;
      const dialog = page.getByRole('dialog');
      await t.shot('05a', ms['05a'], async () => {
        const start = t.now();
        await t.click(page.locator('[data-slot="new-release"]'), {
          duration: 450,
          after: 350,
        });
        await t.click(dialog.locator('#release-version'), {
          duration: 350,
          after: 50,
        });
        await t.type(REVISION);
        await t.click(dialog.locator('[data-slot="next"]'), {
          duration: 350,
          after: 700,
        });
        if (await dialog.locator('[data-field="confirm-warnings"]').count()) {
          throw new Error('the release checks have warnings');
        }
        await t.click(dialog.locator('nav li button').last(), {
          duration: 350,
          after: 200,
        });
        await t.click(dialog.locator('#release-notes'), {
          duration: 300,
          after: 50,
        });
        await page.keyboard.insertText(texts.notes);
        await t.pause(Math.max(300, start + ms['05a'] - 1_000 - t.now()));
        await t.click(dialog.locator('[data-slot="create"]'), {
          duration: 400,
          after: 250,
        });
      });
      // Off the cut: the release's page opens; on a slow machine, the API names it.
      await page
        .waitForURL(/\/releases\/[0-9a-f-]{36}/, { timeout: 60_000 })
        .catch(() => undefined);
      release =
        /\/releases\/([0-9a-f-]{36})/.exec(page.url())?.[1] ??
        (await releaseId(admin, REVISION));
      await finish(P.release, t);
    }

    // Off camera: the release's files; four of them as strips; the portal and the assistant at
    // release 1.2.
    const outputs = await waitForOutputs(
      admin,
      [release],
      300_000,
      console.log,
    );
    if (outputs[REVISION]?.state !== 'done' || outputs[REVISION]?.failed) {
      throw new Error(`release ${REVISION}: ${JSON.stringify(outputs)}`);
    }
    const tiles = [];
    for (const tileLang of [lang, other]) {
      for (const file of HERO_FILES) {
        tiles.push(await pdfTile(admin, release, file, tileLang, work));
      }
    }
    await buildPortal({
      ...reader,
      lang,
      release,
      outDir: portalDir(REVISION),
    });
    const after = await withAssistant(reader, (call) =>
      askAssistant(call, { lang, revision: REVISION }),
    );
    if (!after.found.excerpt.includes(NEW_WORDS)) {
      throw new Error(
        `release ${REVISION}: the assistant reads "${after.found.excerpt}"`,
      );
    }
    portal = await servePortal(portalDir(REVISION));
    const portalStrip = await portalPicture(browser, {
      url: portal.url,
      lang,
      theme,
    });

    // 05b, 06a: release 1.2, its changes and its files; the new words in four of them.
    {
      const t = await take(P['files-1.2'], `/releases/${release}`);
      await t.placeCursor(700, 520);
      await t.shot('05b', ms['05b'], async () => {
        await t.pause(300);
        await t.point(t.page.locator('[aria-controls^="change-"]'), {
          offset: { x: 120, y: 30 },
          duration: 500,
        });
        await t.pause(500);
        await t.point(t.page.locator('[data-slot="files-progress"]'), {
          offset: { x: 60, y: 22 },
          duration: 500,
        });
      });
      await t.shot('06a', ms['06a'], async () => {
        await t.hideCursor();
        await t.showLayer(outputsLayer(tiles));
      });
      await finish(P['files-1.2'], t);
    }

    // 06b, 06c, 07a: the same question, answered: on the portal, by the assistant, everywhere.
    {
      const t = await take(P['portal-1.2']);
      await t.placeCursor(1100, 600);
      await t.shot('06b', ms['06b'], async () => {
        const step = await portalSearch(t, lang);
        if (!(await markOnPage(t.page, step, NEW_WORDS))) {
          throw new Error(`the portal's step has no "${NEW_WORDS}"`);
        }
      });
      await t.shot('06c', ms['06c'], async () => {
        await t.hideCursor();
        await t.showLayer(
          assistantLayer(after.found, {
            lang,
            call: after.call,
            phrase: NEW_WORDS,
          }),
          350,
        );
      });
      await t.shot('07a', ms['07a'], async () => {
        await t.showLayer(
          outletsLayer({
            pictures: { pdf: tiles[0], portal: portalStrip },
            found: after.found,
            lang,
            phrase: NEW_WORDS,
          }),
          350,
        );
      });
      await finish(P['portal-1.2'], t);
    }
  } finally {
    await browser.close();
    await portal.close().catch(() => undefined);
  }

  const joined = joinParts(parts, name);
  console.log(`${joined.file} (${joined.shots.length} shots)`);
  // A shot that ran past its plan: its actions took longer than the line, so the voice has room.
  for (const shot of joined.shots) {
    const planned = ms[shot.id];
    if (shot.end - shot.start > planned + 400) {
      console.warn(
        `${shot.id}: ${shot.end - shot.start} ms, planned ${planned} ms`,
      );
    }
  }
}

/** The review screen's words, per language (the editor's own texts). */
const REVIEW_UI = {
  en: { approve: 'Approve', approvals: 'Approvals' },
  de: { approve: 'Freigeben', approvals: 'Freigaben' },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    // A network failure names its cause (the address refused, the socket closed).
    console.error(
      error.cause ? `${error.message}: ${error.cause}` : error.message,
    );
    process.exit(1);
  });
}
