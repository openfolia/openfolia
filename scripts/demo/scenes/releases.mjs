// The Releases tab video (#446): "What changed, and the PDFs per language." Ada (the admin) cuts
// release 1.2 in the editor's dialog; the release's page then shows what changed since 1.1, per
// manual and language, and its PDFs per variant and language; one of them opens, on the page with
// the new step. Captions: `scripts/demo/captions/releases.json`; the voice-over:
// `scripts/demo/captions/releases.narration.<lang>.md`.
//
//   node scripts/demo/scenes/releases.mjs --lang en|de [--no-reset] [--only 02a,03a]
//
// Before the take the demo is reset (every take starts on the same data) and, off camera, Mira's
// revision of "Changing a wheel" is approved and merged: release 1.2 then has a change since 1.1.
// The take has two parts (`record.mjs`, `joinParts`): the release is cut, then, off camera, its
// files are made (the release's `meta.outputs.state` waited for: releases plan strictly in the
// order cut, so 1.2's files wait for 1.0's and 1.1's, which the reset has finished); then its
// page. The PDF that opens is drawn from the release's own file (`pdfTile`), as the hero's are.
//
// `--only` films those shots alone (a preview): a part none of them is in is not filmed, but the
// release is still cut (off camera when 01b is left out). Writes `.demo/takes/releases-<lang>.*`;
// then `node scripts/demo/assemble.mjs releases --lang <lang>`.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CAPTION_LANGS } from '../captions.mjs';
import { LOOP } from '../look.mjs';
import { narrationPlan, timedShots } from '../narration.mjs';
import { DEMO_DIR, STATE_FILE } from '../paths.mjs';
import { DEMO_PEOPLE } from '../people.mjs';
import { chromium } from '../playwright.mjs';
import {
  Client,
  REVISION,
  reviseWheelChange,
  TRANSLATIONS,
  waitForOutputs,
} from '../populate.mjs';
import { joinParts, Take } from '../record.mjs';
import { HERO_FILES, outputsLayer, pdfTile } from './hero.mjs';

/** The module Mira's revision changes. */
const MODULE = 'changing-a-wheel';
/** The title of the change set that translates the revision (off camera). */
const TRANSLATION_TITLE = {
  en: 'Translate the revised wheel change',
  de: 'Überarbeiteten Radwechsel übersetzen',
};

/** The release the take cuts: the one after the demo's 1.0 and 1.1. */
export const RELEASE = '1.2';

/** The summary pasted into the notes, per language. */
export const NOTES = {
  en: 'The wheel bolts checked again after 50 km.',
  de: 'Radschrauben nach 50 km erneut prüfen.',
};

/**
 * The screen's words the take finds its way by, per language (the editor's own texts and the
 * file names it shows).
 */
const UI = {
  en: { language: 'English', estate: 'Estate' },
  de: { language: 'Deutsch', estate: 'Kombi' },
};

/** The PDF that opens: the owner's manual of the estate (as the hero's first tile). */
export const OPENED = HERO_FILES[0];

/** The new step's words, as a PDF sets them (punctuation after a word left out). */
export const newStep = (lang) =>
  REVISION[lang].step.split(/\s+/).map((word) => word.replace(/[.,;:]+$/, ''));

/** The opened page, in points: from its top (the running head names the variant) to the step. */
export const pageDown = (box, page = { width: 595.276 }) => ({
  x: 0,
  y: 0,
  width: page.width,
  height: box.y1 + 46,
});

/** The shots, in order, each with the least it lasts: its action and a look at the result. */
export const LEAST_MS = {
  '01a': 3_800,
  '01b': 4_600,
  '02a': 3_800,
  '03a': 3_400,
  '03b': 4_400,
};
export const SHOTS = Object.keys(LEAST_MS);
/** What clicking "Create release" takes, from the move to the end of its shot. */
const CREATE_MS = 1_100;
/** The shots of each part of the take: the release is cut, then its page. */
export const PARTS = [
  ['01a', '01b'],
  ['02a', '03a', '03b'],
];

/** Each shot's length in ms: its line's, at least its action's, the loop's blend at the ends. */
export const shotLengths = (plan) => timedShots(plan, LEAST_MS);

/** Part 1: the dialog, from "New release" to "Create release". */
function cut(take, ms) {
  const { page } = take;
  const dialog = page.getByRole('dialog');
  return {
    // "New release", the version typed, and on to the checks.
    '01a': () =>
      take.shot('01a', ms['01a'], async () => {
        await take.click(page.locator('[data-slot="new-release"]'), {
          duration: 550,
          after: 500,
        });
        await take.click(dialog.locator('#release-version'), {
          duration: 450,
          after: 100,
        });
        await take.type(RELEASE);
        await take.click(dialog.locator('[data-slot="next"]'), {
          duration: 450,
          after: 500,
        });
      }),
    // Every check passes: the notes pasted, the release created.
    '01b': () =>
      take.shot('01b', ms['01b'], async () => {
        const start = take.now();
        // The demo's checks are clean: no warning to confirm on camera.
        if (await dialog.locator('[data-field="confirm-warnings"]').count()) {
          throw new Error(
            'the release checks have warnings: see the demo set-up',
          );
        }
        // Straight to the notes: the step list is the dialog's own.
        await take.click(dialog.locator('nav li button').last(), {
          duration: 400,
          after: 250,
        });
        await take.click(dialog.locator('#release-notes'), {
          duration: 350,
          after: 100,
        });
        // Pasted, as the look has longer text.
        await page.keyboard.insertText(NOTES[take.lang]);
        // The shot's time is spent on the notes, before the click: "Create release" comes at
        // its end, so the page never changes inside it.
        await take.pause(
          Math.max(300, start + ms['01b'] - CREATE_MS - take.now()),
        );
        await take.click(dialog.locator('[data-slot="create"]'), {
          duration: 450,
          after: 300,
        });
        // The shot ends on the dialog creating it: the part is cut there, and the next opens
        // on the release's page, loaded (no empty page between them).
      }),
  };
}

/** Part 2: the release's page: its changes, its files, one PDF opened. */
function onPage(take, ms, layer) {
  const { page } = take;
  const ui = UI[take.lang];
  // The changed manual in the take's language (the list has every language).
  const change = page
    .locator('[aria-controls^="change-"]')
    .filter({ hasText: ui.language })
    .first();
  const files = page.locator('of-release-files');
  const row = files
    .getByRole('row')
    .filter({ hasText: ui.estate })
    .filter({ hasText: ui.language })
    .first();
  return {
    // What changed since 1.1: a manual opens to the module that changed.
    '02a': () =>
      take.shot('02a', ms['02a'], async () => {
        await take.pause(300);
        await take.click(change, { offset: { x: 14, y: 16 }, after: 600 });
        await take.point(page.locator('[id^="change-"] li').first(), {
          at: { x: 0.2, y: 1.6 },
          duration: 600,
        });
      }),
    // Every file ready; the list moves on to the manuals' PDFs, per variant and language.
    '03a': () =>
      take.shot('03a', ms['03a'], async () => {
        const table = files.getByRole('table');
        const box = await table.boundingBox();
        await take.move(box.x + box.width * 0.35, box.y + 150, {
          duration: 700,
        });
        await take.pause(200);
        for (let i = 0; i < 16; i++) {
          await page.mouse.wheel(0, 22);
          await take.pause(28);
        }
        await take.pause(300);
        // Beside the file's name, on the row's empty middle: the dot covers no word.
        await take.point(row, { at: { x: 0.6, y: 0.5 }, duration: 500 });
      }),
    // One opens: the page with the new step, the step marked.
    '03b': () =>
      take.shot('03b', ms['03b'], async () => {
        await take.click(
          row.getByRole('button', { name: /download|herunterladen/i }),
          { after: 300 },
        );
        await take.hideCursor();
        await take.showLayer(layer, 350);
      }),
  };
}

/**
 * Off camera, after Mira's revision is merged: its translations follow, so the release's checks
 * have no warnings (no outdated translation). The revision changed English, and for a German
 * take German too (`populate.mjs`); the rest is revised here and every translation marked
 * current, in a change set of Ada's, reviewed by Jonas and merged.
 */
export async function translateRevision(admin, reviewer, lang) {
  const set = await admin.changeSet(TRANSLATION_TITLE[lang]);
  for (const target of TRANSLATIONS) {
    if (target === lang) {
      // Revised in the review already: locked only, to be marked current.
      await admin.post(`/change-sets/${set}/locks`, {
        data: {
          type: 'Lock',
          attributes: {
            subject: { type: 'module', lang: target, moduleId: MODULE },
          },
        },
      });
    } else {
      await admin.editModule(set, target, MODULE, (module) =>
        reviseWheelChange(module, target),
      );
    }
  }
  await admin.savePoint(set);
  for (const target of TRANSLATIONS) {
    await admin.markCurrent(set, MODULE, target);
  }
  await admin.transition(set, 'submit', TRANSLATION_TITLE[lang]);
  await reviewer.transition(set, 'approve');
  await admin.transition(set, 'merge');
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
  if (only.includes('01a') && !only.includes('01b')) {
    throw new Error('--only: 01a goes with 01b, which cuts the release');
  }
  if (!values['no-reset']) {
    execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, '..', 'demo.mjs'),
        ...['reset', '--lang', lang, '--user', 'admin', '--no-build'],
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
  const plan = narrationPlan('releases', lang);
  const ms = shotLengths(plan);
  console.log(
    `${plan.voiced ? 'timed from the voice' : 'timed from an estimate (no voice yet)'}: ${Object.values(ms).reduce((a, b) => a + b, 0) / 1000 - LOOP.blend} s`,
  );
  const admin = new Client(state.apiUrl, state.token, DEMO_PEOPLE.admin);
  const reviewer = new Client(state.apiUrl, state.token, DEMO_PEOPLE.reviewer);

  // Off camera: Mira's revision in review is approved and merged, so 1.2 has a change.
  const { data: sets } = await admin.get('/change-sets?page[size]=100');
  const inReview = sets.filter((set) => set.attributes.state === 'in-review');
  if (inReview.length !== 1) {
    throw new Error(`${inReview.length} change sets in review, the demo has 1`);
  }
  await reviewer.transition(inReview[0].id, 'approve');
  await admin.transition(inReview[0].id, 'merge');
  await translateRevision(admin, reviewer, lang);

  const work = join(DEMO_DIR, 'takes', 'work', `releases-${lang}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const filmed = PARTS.map((ids) => ids.filter((id) => only.includes(id)));
  const browser = await chromium.launch();
  const parts = [];
  try {
    // Part 1: the release is cut in the dialog (or, left out of the preview, through the API).
    let release;
    if (filmed[0].length) {
      const take = await Take.start(browser, {
        video: 'releases',
        lang,
        user: 'admin',
        state,
        path: '/releases',
      });
      await take.placeCursor(1240, 300);
      const shots = cut(take, ms);
      for (const id of filmed[0]) await shots[id]();
      // Off the cut: the release is created and its page opens.
      await take.page.waitForURL(/\/releases\/[0-9a-f-]{36}/, {
        timeout: 60_000,
      });
      release = /\/releases\/([0-9a-f-]{36})/.exec(take.page.url())[1];
      parts.push(await take.finish({ name: `releases-${lang}.part1` }));
    } else {
      release = await admin.release(RELEASE, NOTES[lang]);
    }

    // Off camera: the release's files, every one of them settled.
    const outputs = await waitForOutputs(
      admin,
      [release],
      300_000,
      console.log,
    );
    if (outputs[RELEASE]?.state !== 'done' || outputs[RELEASE]?.failed) {
      throw new Error(`release ${RELEASE}: ${JSON.stringify(outputs)}`);
    }
    const tile = await pdfTile(admin, release, OPENED, lang, work, {
      phrase: newStep(lang),
      crop: pageDown,
    });
    const layer = outputsLayer([tile], { tileWidth: 860, columns: 1 });

    // Part 2: the release's page.
    if (filmed[1].length) {
      const take = await Take.start(browser, {
        video: 'releases',
        lang,
        user: 'admin',
        state,
        path: `/releases/${release}`,
      });
      await take.placeCursor(1240, 300);
      const shots = onPage(take, ms, layer);
      for (const id of PARTS[1]) {
        if (filmed[1].includes(id)) await shots[id]();
      }
      parts.push(await take.finish({ name: `releases-${lang}.part2` }));
    }
  } finally {
    await browser.close();
  }
  const take = joinParts(parts, `releases-${lang}`);
  console.log(
    `${take.file}: ${take.shots.map((s) => `${s.id} ${((s.end - s.start) / 1000).toFixed(1)} s`).join(', ')}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
