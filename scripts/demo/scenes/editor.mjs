// The Editor tab video (#443): writing a module. Mira opens "Checking the tyre pressure" in a
// revision of her own and writes: a new step in the procedure, a variant block only the estate
// shows (the editor lists the builds it reaches), a warning through the slash menu, the shared
// snippet "Secure the vehicle" by reference from the toolbar; then the module is saved on its own
// and the live preview shows it, with the estate's block hidden for the variant it shows.
// Captions: `scripts/demo/captions/editor.json`; the voice-over:
// `scripts/demo/captions/editor.narration.<lang>.md`.
//
//   node scripts/demo/scenes/editor.mjs --lang en|de [--no-reset] [--only 01a,02a]
//
// Each shot lasts as long as its spoken line (`narration.mjs`: the voice once the owner has made
// it, an estimate from the words before), and at least as long as its action needs. The first and
// the last shot have the loop's blend on top, so no line is under it.
//
// Before the take the demo is reset (`demo.mjs reset --lang <lang> --no-build`) and Mira's
// revision is made through the API, off camera, so every take starts on the same module. `--only`
// films those shots alone (a preview): the shots before them run off camera first, and the take
// ends after the last of them. Writes `.demo/takes/editor-<lang>.*`; then
// `node scripts/demo/assemble.mjs editor --lang <lang>`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CAPTION_LANGS } from '../captions.mjs';
import { LOOP } from '../look.mjs';
import { narrationPlan } from '../narration.mjs';
import { STATE_FILE } from '../paths.mjs';
import { DEMO_PEOPLE } from '../people.mjs';
import { chromium } from '../playwright.mjs';
import { Client } from '../populate.mjs';
import { Take } from '../record.mjs';

/** The module the take writes in: a short procedure, with no image, that fits the window. */
export const MODULE = 'checking-tyre-pressure';

/**
 * What the take writes, per language: the revision's title, the new step, the estate's note,
 * the warning's hazard and measure. Short, so typing them keeps the look's pace.
 */
export const EDITOR_TEXTS = {
  en: {
    changeSet: 'Tyre pressure check',
    step: 'Check the spare wheel too.',
    estate: 'Loaded estates need more air.',
    hazard: 'Wrong pressure can burst a tyre.',
    measure: 'Keep to the values given.',
  },
  de: {
    changeSet: 'Reifendruck prüfen',
    step: 'Prüfen Sie auch das Reserverad.',
    estate: 'Beladen braucht der Kombi mehr Luft.',
    hazard: 'Falscher Druck lässt Reifen platzen.',
    measure: 'Halten Sie die Werte ein.',
  },
};

/** The screen's words the take finds its way by, per language (the editor's own texts). */
const UI = {
  en: {
    insert: 'Insert a block',
    variantQuery: '/vari',
    chooseVariants: 'Choose variants',
    estate: 'Estate',
    apply: 'Apply',
    safetyQuery: '/saf',
    snippet: /^Snippet/,
    secureVehicle: 'Secure the vehicle',
    insertSnippet: 'Insert',
    saved: /^Saved/,
    preview: 'Preview',
  },
  de: {
    insert: 'Block einfügen',
    variantQuery: '/vari',
    chooseVariants: 'Varianten wählen',
    estate: 'Kombi',
    apply: 'Übernehmen',
    safetyQuery: '/sich',
    snippet: /^Textbaustein/,
    secureVehicle: 'Fahrzeug sichern',
    insertSnippet: 'Einfügen',
    saved: /^Gespeichert/,
    preview: 'Vorschau',
  },
};

/** How long the dot takes to a click's target: a little quicker than the kit's 650 ms. */
const MOVE_MS = 450;

/** Just under the words pointed at, so the dot never covers what the viewer reads. */
const UNDER = { x: 0.3, y: 1.6 };

/** The shots, in order, each with the least it lasts: its action and a look at the result. */
export const LEAST_MS = {
  '01a': 3_400,
  '02a': 8_200,
  '03a': 5_200,
  '04a': 5_600,
  '05a': 3_800,
};
export const SHOTS = Object.keys(LEAST_MS);

/** Each shot's length in ms: its line's, at least its action's, the loop's blend at the ends. */
export function shotLengths(plan) {
  const ids = plan.shots.map((shot) => shot.id);
  if (ids.join() !== SHOTS.join()) {
    throw new Error(`the narration's shots ${ids} are not the take's ${SHOTS}`);
  }
  const blend = LOOP.blend * 1000;
  return Object.fromEntries(
    plan.shots.map((shot, i) => [
      shot.id,
      Math.max(shot.ms, LEAST_MS[shot.id]) +
        (i === 0 || i === SHOTS.length - 1 ? blend : 0),
    ]),
  );
}

/** Each shot's action: what happens on screen, without its hold. */
function actions(take) {
  const { page } = take;
  const ui = UI[take.lang];
  const texts = EDITOR_TEXTS[take.lang];
  const editor = page.locator('[contenteditable="true"]').first();
  const steps = editor.locator('[data-node="listItem"] [data-node="itemText"]');
  const intro = editor.locator(':scope > p').first();
  const insert = page.getByRole('button', { name: ui.insert }).first();
  const dialog = page.getByRole('dialog');

  /** A click with a quicker move than the kit's default: the story has many steps. */
  const click = (target, options = {}) =>
    take.click(target, { duration: MOVE_MS, ...options });
  /**
   * Clicks at the end of a block of text and puts the caret there: on its last line (a long
   * paragraph wraps, and End goes to the end of the line clicked).
   */
  const caretAtEnd = async (line) => {
    await click(line, { at: { x: 0.98, y: 0.85 }, after: 250 });
    await page.keyboard.press('End');
  };
  /** The dot steps aside, below the line being typed, so it never covers the words. */
  const aside = (line) =>
    take.point(line, { duration: 400, at: { x: 0.75, y: 2.4 } });

  return {
    // A new last step in the procedure.
    '01a': async () => {
      await take.pause(400);
      await caretAtEnd(steps.last());
      await page.keyboard.press('Enter');
      await aside(steps.last());
      await take.type(texts.step);
    },
    // A variant block through the slash menu, its note, then shown only for the estate: the
    // dialog lists the builds that show it.
    '02a': async () => {
      // Out of the list: the caret on a new paragraph under the procedure.
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await take.type(ui.variantQuery);
      await take.pause(500);
      await page.keyboard.press('Enter');
      await take.pause(250);
      const variant = editor.locator('[data-node="variant"]').last();
      await aside(variant.locator('p').last());
      await take.type(texts.estate);
      await take.pause(150);
      await click(variant.getByRole('button', { name: ui.chooseVariants }), {
        after: 250,
      });
      await click(dialog.getByRole('checkbox', { name: ui.estate }), {
        after: 900,
      });
      await click(dialog.getByRole('button', { name: ui.apply }), {
        after: 300,
      });
    },
    // A warning through the slash menu, after the introduction: its hazard, then its measure.
    '03a': async () => {
      await caretAtEnd(intro);
      await page.keyboard.press('Enter');
      await take.type(ui.safetyQuery);
      await take.pause(600);
      await page.keyboard.press('Enter');
      await take.pause(250);
      const notice = editor.locator('[data-node="safety"]').first();
      await take.point(notice, { duration: 400, at: { x: 0.8, y: 1.25 } });
      await take.type(texts.hazard);
      // Down into the notice's own measure line (Enter would add a line between them, which
      // reads as the consequence).
      await page.keyboard.press('ArrowDown');
      await take.type(texts.measure);
    },
    // The snippet "Secure the vehicle", by reference, from the toolbar's insert menu, after the
    // introduction (with the caret in the warning, it would become the warning's measure).
    '04a': async () => {
      await caretAtEnd(intro);
      await click(insert, { after: 250 });
      await click(page.getByRole('option', { name: ui.snippet }).first(), {
        after: 300,
      });
      // The picker lists the snippets by title and shows the first: in German that is another
      // one, so "Fahrzeug sichern" is chosen by name.
      // The list first: until it is there, nothing is shown yet either.
      await dialog
        .getByText(ui.secureVehicle, { exact: true })
        .first()
        .waitFor({ timeout: 10_000 });
      await take.pause(300);
      const shown = dialog.getByRole('heading', { name: ui.secureVehicle });
      if (!(await shown.isVisible())) {
        await click(
          dialog.getByText(ui.secureVehicle, { exact: true }).first(),
          {
            after: 500,
          },
        );
      }
      await click(
        dialog.getByRole('button', { name: ui.insertSnippet, exact: true }),
        { after: 300 },
      );
    },
    // The live preview opens beside the text; the module saved itself meanwhile.
    '05a': async () => {
      await click(page.getByRole('button', { name: ui.preview }), {
        after: 700,
      });
      const saved = page.getByRole('status').filter({ hasText: ui.saved });
      await saved.first().waitFor({ timeout: 10_000 });
      await take.point(saved, { duration: 700, at: UNDER });
    },
  };
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
  if (!values['no-reset']) {
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, '..', 'demo.mjs'),
        'reset',
        '--lang',
        lang,
        '--no-build',
      ],
      { stdio: 'inherit' },
    );
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  if (state.options?.lang !== lang) {
    throw new Error(
      `the demo runs in ${state.options?.lang}: reset it with --lang ${lang}`,
    );
  }
  const plan = narrationPlan('editor', lang);
  const lengths = shotLengths(plan);
  console.log(
    `${plan.voiced ? 'timed from the voice' : 'timed from an estimate (no voice yet)'}: ${Object.values(lengths).reduce((a, b) => a + b, 0) / 1000 - LOOP.blend} s`,
  );
  // Mira's own revision, off camera: the module opens in it, ready to write.
  const mira = new Client(state.apiUrl, state.token, DEMO_PEOPLE.author);
  const changeSet = await mira.changeSet(EDITOR_TEXTS[lang].changeSet);
  const browser = await chromium.launch();
  try {
    const take = await Take.start(browser, {
      video: 'editor',
      lang,
      user: 'author',
      state,
      path: `/content/${lang}/${MODULE}?cs=${changeSet}`,
    });
    await take.page
      .locator('[contenteditable="true"] [data-node="listItem"]')
      .first()
      .waitFor({ timeout: 20_000 });
    await take.placeCursor(1180, 880);
    const act = actions(take);
    const last = Math.max(...only.map((id) => SHOTS.indexOf(id)));
    for (const id of SHOTS.slice(0, last + 1)) {
      if (only.includes(id)) await take.shot(id, lengths[id], act[id]);
      else await act[id]();
    }
    const { file, shots: done } = await take.finish();
    console.log(
      `${file}: ${done.map((s) => `${s.id} ${((s.end - s.start) / 1000).toFixed(1)} s`).join(', ')}`,
    );
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
