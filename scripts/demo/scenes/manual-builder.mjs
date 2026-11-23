// The Manual builder tab video (#444): assembling modules, with the PDF preview. Mira, in a new
// revision, adds the high-voltage safety notice to the quick start guide, drags it into place
// after the airbags and keeps it to the electric variants; the preview for petrol leaves it out,
// the one for electric has it in the contents; and the PDF, built from the revision, has it in
// its contents and on a page of its own. Captions: `scripts/demo/captions/manual-builder.json`;
// the voice-over: `scripts/demo/captions/manual-builder.narration.<lang>.md`.
//
//   node scripts/demo/scenes/manual-builder.mjs --lang en|de [--no-reset] [--only 01a,01b]
//
// Each shot lasts as long as its spoken line (`narration.mjs`), and at least as long as its
// action needs; the first and the last have the loop's blend on top. The demo is reset before
// the take, then the revision is started through the API (off camera), so the take opens on the
// manual in it. `--only` films the shots from the first to the last named one (a preview: each
// shot needs the ones before it). Writes `.demo/takes/manual-builder-<lang>.*`; then
// `node scripts/demo/assemble.mjs manual-builder --lang <lang>`.
//
// The PDF opens in a new tab, which the take's browser has no viewer for: the take keeps the
// file the click built, closes the tab and shows two of its pages (the contents and the module's
// page, drawn with `pdftoppm`) as a layer of its own over the preview, the new module marked.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CAPTION_LANGS } from '../captions.mjs';
import { loopedSeconds, narrationPlan, timedShots } from '../narration.mjs';
import { LOOP } from '../look.mjs';
import { DEMO_DIR } from '../paths.mjs';
import { DEMO_PEOPLE } from '../people.mjs';
import { chromium } from '../playwright.mjs';
import { Client } from '../populate.mjs';
import { demoState, resetDemo, Take } from '../record.mjs';
import { pageWords, phraseBox } from './hero.mjs';

const VIDEO = 'manual-builder';
const MANUAL = 'quick-start';

/**
 * What the take writes and finds its way by, per language: the revision's title (written through
 * the API), what is typed into the add list, the module as the builder lists it (`listed`) and
 * as the preview and the PDF show it (`module`, `title` its words), the variants' words in the
 * preview's list, and the editor's own texts.
 */
export const BUILDER_TEXTS = {
  en: {
    changeSet: 'High-voltage notice in the quick start',
    search: 'High',
    searchLabel: 'Search modules',
    listed: 'High-voltage system',
    module: 'High-voltage system',
    title: ['High-voltage', 'system'],
    electric: 'Electric',
    estate: 'Estate',
    apply: 'Apply',
    variant: 'Variant',
    output: 'Output',
    buildPdf: 'Build and open PDF',
  },
  de: {
    changeSet: 'Hochvolt-Hinweis in der Kurzanleitung',
    search: 'Hoch',
    searchLabel: 'Module suchen',
    // The builder lists modules by their source title (#731); the preview and PDF are German.
    listed: 'High-voltage system',
    module: 'Hochvoltsystem',
    title: ['Hochvoltsystem'],
    electric: 'Elektro',
    estate: 'Kombi',
    apply: 'Übernehmen',
    variant: 'Variante',
    output: 'Ausgabe',
    buildPdf: 'PDF erstellen und öffnen',
  },
};

/** Just under the words pointed at, so the dot never covers what the viewer reads. */
const UNDER = { x: 0.3, y: 1.6 };

/** The shots, in order, each with the least it lasts: its action and a look at the result. */
export const LEAST_MS = {
  '01a': 4_000,
  '01b': 3_400,
  '01c': 5_400,
  '02a': 3_600,
  '02b': 3_600,
  '03a': 5_600,
};
export const SHOTS = Object.keys(LEAST_MS);
/** How long the PDF's pages hold before the loop's blend: a screen the viewer reads. */
export const LAYER_HOLD_MS = 2_000;

/** Each shot's length in ms: its line's, at least its action's, the loop's blend at the ends. */
export const shotLengths = (plan) => timedShots(plan, LEAST_MS);

/**
 * The PDF's two pages the last shot shows: the first page with the module's title (the
 * contents) and the first page after it where the title is set larger than body text (the
 * module's heading). `pages` are each page's words (`pageWords`); the result is 1-based page
 * numbers with the title's box on each, in points.
 */
export function pdfPages(pages, title) {
  const found = pages
    .map((words, i) => ({ page: i + 1, box: phraseBox(words, title) }))
    .filter((hit) => hit.box);
  const contents = found[0];
  const heading = found.find(
    (hit) => hit.page > (contents?.page ?? 0) && hit.box.y1 - hit.box.y0 > 14,
  );
  if (!contents || !heading) {
    throw new Error(
      `the PDF has no contents line and heading "${title.join(' ')}"`,
    );
  }
  return [contents, heading];
}

/**
 * The last shot's layer: the PDF's pages side by side on the dark scrim, as a viewer opens them,
 * the module's title marked on each with the hero's green highlight. `pages` hold the page
 * picture (a data URL), the page's size and the title's box, both in points.
 */
export function pdfLayer(pages, { height = 860 } = {}) {
  const html = pages
    .map((page, i) => {
      const scale = height / page.height;
      const width = Math.round(page.width * scale);
      const mark = {
        left: page.box.x0 * scale - 5,
        top: page.box.y0 * scale - 3,
        width: (page.box.x1 - page.box.x0) * scale + 10,
        height: (page.box.y1 - page.box.y0) * scale + 6,
      };
      return `<div style="position:relative;width:${width}px;height:${height}px;border-radius:4px;overflow:hidden;background:#fff;box-shadow:0 18px 50px rgba(0,0,0,.45);animation:demo-page 420ms cubic-bezier(.22,.9,.3,1) ${i * 140}ms both">
  <img src="${page.picture}" style="position:absolute;inset:0;width:100%;height:100%;max-width:none" alt="">
  <i style="position:absolute;left:${mark.left.toFixed(1)}px;top:${mark.top.toFixed(1)}px;width:${mark.width.toFixed(1)}px;height:${mark.height.toFixed(1)}px;border-radius:5px;background:rgba(105,153,93,.32);box-shadow:inset 0 -3px 0 #69995d;transform-origin:0 50%;animation:demo-mark 520ms cubic-bezier(.65,0,.25,1) ${700 + i * 260}ms both"></i>
</div>`;
    })
    .join('');
  return `<style>
@keyframes demo-page { from { opacity: 0; transform: translateY(12px); filter: blur(6px) } to { opacity: 1; transform: none; filter: none } }
@keyframes demo-mark { from { transform: scaleX(0) } to { transform: scaleX(1) } }
</style>
<div style="position:absolute;inset:0;background:rgba(14,15,17,.9);display:flex;align-items:center;justify-content:center;gap:40px">${html}</div>`;
}

// A whole PDF's words can run past the default 1 MB of output.
const run = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Each page's part of `pdftotext -bbox`'s XHTML, in order. */
export const splitPages = (xhtml) =>
  [...xhtml.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)].map(
    ([, page]) => page,
  );

/**
 * The PDF's two pages as the layer needs them: pictures, sizes and the title's boxes. One read
 * of the whole file's words (a program run per page would hold the shot up for seconds).
 */
export function drawPages(pdf, title, dir) {
  const words = splitPages(run('pdftotext', ['-bbox', pdf, '-'])).map(
    pageWords,
  );
  const size = /Page size:\s+([\d.]+) x ([\d.]+)/.exec(run('pdfinfo', [pdf]));
  const [width, height] = [
    Number(size?.[1] ?? 595.276),
    Number(size?.[2] ?? 841.89),
  ];
  return pdfPages(words, title).map(({ page, box }) => {
    const prefix = join(dir, `page-${page}`);
    run('pdftoppm', [
      ...['-r', '150', '-png', '-singlefile'],
      ...['-f', String(page), '-l', String(page), pdf, prefix],
    ]);
    return {
      picture: `data:image/png;base64,${readFileSync(`${prefix}.png`).toString('base64')}`,
      width,
      height,
      box,
    };
  });
}

/** Waits until `target` stops moving (two reads of its box 120 ms apart agree). */
async function settled(take, target, timeout = 5_000) {
  const end = Date.now() + timeout;
  let last = '';
  while (Date.now() < end) {
    const box = JSON.stringify(await target.first().boundingBox());
    if (box === last) return;
    last = box;
    await take.pause(120);
  }
  console.warn(`still moving after ${timeout} ms: ${target}`);
}

function film(take, ms, { work }) {
  const { page } = take;
  const text = BUILDER_TEXTS[take.lang];
  const tree = page.getByRole('tree');
  const added = tree.getByRole('treeitem').filter({ hasText: text.listed });
  const preview = page.frameLocator('iframe').first();

  return {
    // The add list, searched, and the module picked: it lands at the end of the outline.
    '01a': () =>
      take.shot('01a', ms['01a'], async () => {
        await take.pause(250);
        await take.click(page.getByTestId('manual-add'), {
          after: 350,
          at: { x: 0.8, y: 0.75 },
        });
        const search = page.getByRole('combobox', {
          name: text.searchLabel,
          exact: true,
        });
        await search.focus();
        await take.type(text.search);
        // The list searched: the module is its first option, in view.
        const option = page.getByRole('option').first();
        await page.waitForFunction(
          (name) =>
            document.querySelector('[role="option"]')?.textContent?.trim() ===
            name,
          text.listed,
          { timeout: 10_000 },
        );
        await take.pause(350);
        await take.click(option, { after: 250, at: { x: 0.2, y: 0.5 } });
        await added.waitFor({ timeout: 10_000 });
        // Off the list's old place (it would light up a row), onto the new row.
        await take.point(added, { offset: { x: 140, y: 30 }, duration: 500 });
      }),
    // Dragged by its handle up to the place after the airbags.
    '01b': () =>
      take.shot('01b', ms['01b'], async () => {
        const handle = added.locator('[cdkdraghandle]');
        await take.point(handle, { duration: 600 });
        const box = await handle.boundingBox();
        const target = await tree.getByRole('treeitem').nth(2).boundingBox();
        await page.mouse.down();
        await take.pause(120);
        await take.move(box.x + box.width / 2, target.y + 6, {
          duration: 1_100,
        });
        await take.pause(200);
        await page.mouse.up();
        await take.pause(400);
        const third = await tree.getByRole('treeitem').nth(2).innerText();
        if (!third.includes(text.listed)) {
          throw new Error(`the drop left "${third}" third`);
        }
      }),
    // Only for the electric variants: its row's menu, the variant picker, Electric, Apply.
    '01c': () =>
      take.shot('01c', ms['01c'], async () => {
        // Short hops inside the menu and the dialog: a hand that knows the way.
        await take.click(added.locator('[data-row-menu]'), { after: 250 });
        await take.click(page.getByRole('menuitem').first(), {
          after: 400,
          at: { x: 0.3, y: 0.5 },
          duration: 380,
        });
        const dialog = page.getByRole('dialog');
        await take.click(
          dialog.getByRole('checkbox', { name: text.electric, exact: true }),
          { after: 400, duration: 450 },
        );
        // The dialog grows with the builds the choice reaches: Apply is clicked where it stays.
        const apply = dialog.getByRole('button', {
          name: text.apply,
          exact: true,
        });
        await settled(take, apply);
        await take.click(apply, { after: 350, duration: 450 });
        await take.point(added.locator('[data-testid="row-condition"]'), {
          at: UNDER,
          duration: 450,
        });
      }),
    // The preview, on the first variant (petrol): what it hides names the new module.
    '02a': () =>
      take.shot('02a', ms['02a'], async () => {
        await take.click(page.getByTestId('manual-preview'), { after: 0 });
        await page.waitForURL(/\/preview\?/);
        // The kit's cursor lives in the page, which gets no mouse moves over the preview's frame:
        // for the take only, the frame lets them through, so the dot follows onto the contents.
        await page.addStyleTag({
          content: 'iframe { pointer-events: none !important; }',
        });
        await preview.getByRole('heading').first().waitFor({ timeout: 20_000 });
        await take.settle(300);
        await take.point(
          page.locator('strong').filter({ hasText: text.module }),
          { at: UNDER, duration: 600 },
        );
      }),
    // The variant switched to the estate (electric): the contents have the module.
    '02b': () =>
      take.shot('02b', ms['02b'], async () => {
        // Where the module will appear: the contents line under the airbags. The preview reloads
        // for the new variant, so the cursor goes there while it does, and lands on the line once
        // it is in.
        const airbags = await preview
          .getByRole('link', { name: 'Airbags', exact: true })
          .first()
          .boundingBox();
        await take.click(
          page.getByRole('combobox', {
            name: new RegExp(`^${text.variant}\\b`),
          }),
          { after: 400 },
        );
        await take.click(
          page.getByRole('option').filter({ hasText: text.estate }).first(),
          { after: 150, at: { x: 0.25, y: 0.5 } },
        );
        if (airbags) {
          await take.move(
            airbags.x + airbags.width * 0.6,
            airbags.y + airbags.height * 2.6,
            { duration: 700 },
          );
        }
        const entry = preview
          .getByRole('link', { name: text.module, exact: true })
          .first();
        await entry.waitFor({ timeout: 20_000 });
        await take.point(entry, { at: UNDER, duration: 250 });
      }),
    // The PDF, built from the revision for that variant: its contents and the module's page.
    '03a': () =>
      take.shot('03a', ms['03a'], async () => {
        await take.click(
          page
            .getByRole('radiogroup', { name: text.output })
            .locator('label')
            .filter({
              has: page.getByRole('radio', { name: 'PDF', exact: true }),
            }),
          { after: 250, duration: 500 },
        );
        const built = take.context.waitForEvent('response', {
          predicate: (r) =>
            (r.headers()['content-type'] ?? '').startsWith('application/pdf'),
          timeout: 60_000,
        });
        const tab = take.context.waitForEvent('page', { timeout: 60_000 });
        await take.click(
          page.getByRole('button', { name: text.buildPdf, exact: true }),
          { after: 0, duration: 500 },
        );
        const response = await built;
        if (!response.ok()) throw new Error(`the PDF: ${response.status()}`);
        const pdf = join(work, `${MANUAL}.pdf`);
        writeFileSync(pdf, await response.body());
        await (await tab).close();
        const pages = drawPages(pdf, text.title, work);
        await take.hideCursor();
        await take.showLayer(pdfLayer(pages));
        // The pages read for 2 s, then the loop's blend: the shot holds at least that long.
        await take.pause(LAYER_HOLD_MS + LOOP.blend * 1000);
      }),
  };
}

/**
 * The manual's PDF built once off camera (the released content, the variant the take opens), so
 * the PDF workers are warm and the build on camera takes as long as it would for a reader, not
 * a cold start's.
 */
async function warmPdf(client, lang) {
  const variant = encodeURIComponent('body=estate,drive=electric,market=eu');
  const response = await fetch(
    `${client.apiUrl}/manuals/${MANUAL}/variants/${variant}/${lang}/pdf`,
    {
      headers: {
        Authorization: `Bearer ${client.token}`,
        'X-Ccms-User': client.person.id,
      },
      signal: AbortSignal.timeout(120_000),
    },
  );
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`warming the PDF: ${response.status}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      lang: { type: 'string' },
      'no-reset': { type: 'boolean' },
      only: { type: 'string' },
    },
  });
  const lang = values.lang;
  if (!CAPTION_LANGS.includes(lang))
    throw new Error(`--lang: one of ${CAPTION_LANGS}`);
  const only = values.only?.split(',') ?? SHOTS;
  const unknown = only.filter((id) => !SHOTS.includes(id));
  if (unknown.length) throw new Error(`--only: unknown shots ${unknown}`);
  const last = Math.max(...only.map((id) => SHOTS.indexOf(id)));
  if (!values['no-reset']) resetDemo(lang, ['--user', 'author']);
  const state = demoState(lang);
  const plan = narrationPlan(VIDEO, lang);
  const lengths = shotLengths(plan);
  console.log(
    `${plan.voiced ? 'timed from the voice' : 'timed from an estimate (no voice yet)'}: ${loopedSeconds(lengths)} s`,
  );
  const work = join(DEMO_DIR, 'takes', 'work', `${VIDEO}-${lang}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  // The revision Mira works in, off camera: the take opens on the manual in it.
  const author = new Client(state.apiUrl, state.token, DEMO_PEOPLE.author);
  const changeSet = await author.changeSet(BUILDER_TEXTS[lang].changeSet);
  await warmPdf(author, lang);
  const browser = await chromium.launch();
  try {
    const take = await Take.start(browser, {
      video: VIDEO,
      lang,
      user: 'author',
      state,
      // In the take's language, which the preview then opens in (its default is the source's).
      path: `/manuals?manual=${MANUAL}&cs=${changeSet}&lang=${lang}`,
    });
    await take.page.getByRole('tree').getByRole('treeitem').first().waitFor();
    await take.settle(800);
    await take.placeCursor(900, 700);
    const shots = film(take, lengths, { work });
    // A shot needs the ones before it: those not asked for are filmed too, at their full length
    // (the take starts at the first shot it films).
    for (const id of SHOTS.slice(0, last + 1)) {
      await shots[id]().catch(async (error) => {
        // What the screen showed when the shot failed, for the person filming.
        await take.page.screenshot({ path: join(work, `problem-${id}.png`) });
        throw error;
      });
      if (!only.includes(id)) console.warn(`${id}: filmed, not asked for`);
    }
    const { file, shots: done } = await take.finish();
    console.log(
      `${file}: ${done.map((s) => `${s.id} ${((s.end - s.start) / 1000).toFixed(1)} s`).join(', ')}`,
    );
    for (const shot of done) {
      if (shot.end - shot.start > lengths[shot.id] + 400) {
        console.warn(
          `${shot.id}: ${shot.end - shot.start} ms, planned ${lengths[shot.id]} ms`,
        );
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
