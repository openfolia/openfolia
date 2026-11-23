// The Review tab video (#445): comparing changes and approving them. Jonas (the reviewer) opens
// Mira's revision of "Changing a wheel" on its changes, inline and side by side; the question on
// the first step has Mira's answer, and the thread is resolved; then the revision is approved,
// and shows as ready to merge. Captions: `scripts/demo/captions/review.json`; the voice-over:
// `scripts/demo/captions/review.narration.<lang>.md`.
//
//   node scripts/demo/scenes/review.mjs --lang en|de [--no-reset] [--only 01a,01b]
//
// Each shot lasts as long as its spoken line (`narration.mjs`: the voice once the owner has made
// it, an estimate from the words before), and at least as long as its action needs. The first and
// the last shot have the loop's blend on top, so no line is under it.
//
// Before the take the demo is reset (`demo.mjs reset --lang <lang> --no-build`), so every take
// starts on the same data: the change set in review, with its comments, nothing resolved or
// approved. `--only` films those shots alone (a preview). Writes `.demo/takes/review-<lang>.*`;
// then `node scripts/demo/assemble.mjs review --lang <lang>`.

import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CAPTION_LANGS } from '../captions.mjs';
import { loopedSeconds, narrationPlan, timedShots } from '../narration.mjs';
import { chromium } from '../playwright.mjs';
import { demoState, resetDemo, Take } from '../record.mjs';

/** The screen's words the take finds its way by, per language (the editor's own texts). */
const UI = {
  en: { resolve: 'Resolve', approve: 'Approve', approvals: 'Approvals' },
  de: { resolve: 'Erledigt', approve: 'Freigeben', approvals: 'Freigaben' },
};

/** Just under the words pointed at, so the dot never covers what the viewer reads. */
const UNDER = { x: 0.3, y: 1.6 };

/** The shots, in order, each with the least it lasts: its action and a look at the result. */
export const LEAST_MS = {
  '01a': 4_000,
  '01b': 3_600,
  '02a': 4_500,
  '02b': 3_500,
  '03a': 4_800,
};
export const SHOTS = Object.keys(LEAST_MS);

/** Each shot's length in ms: its line's, at least its action's, the loop's blend at the ends. */
export const shotLengths = (plan) => timedShots(plan, LEAST_MS);

function film(take, ms) {
  const { page } = take;
  const ui = UI[take.lang];
  // The thread on the first step: Jonas's question, with Mira's answer.
  const thread = page.getByRole('region', { name: /Jonas Feld/ }).first();
  const side = page.locator('label').filter({
    has: page.locator('input[type="radio"][value="side"]'),
  });
  const approve = page.getByRole('button', { name: ui.approve, exact: true });
  const approvals = page.getByRole('region', {
    name: ui.approvals,
    exact: true,
  });

  return {
    // The revision on its changes, word by word: the cursor reads along the changed step.
    '01a': () =>
      take.shot('01a', ms['01a'], async () => {
        await take.pause(600);
        await take.point(page.locator('ins').first(), {
          duration: 900,
          at: UNDER,
        });
        await take.pause(400);
        await take.point(page.locator('ins').nth(1), {
          duration: 500,
          at: UNDER,
        });
      }),
    // Side by side: before on the left, after on the right.
    '01b': () =>
      take.shot('01b', ms['01b'], async () => {
        await take.click(side);
      }),
    // The question on the step, and Mira's answer under it.
    '02a': () =>
      take.shot('02a', ms['02a'], async () => {
        await take.point(thread.getByRole('paragraph').first(), {
          duration: 800,
          at: UNDER,
        });
        await take.pause(600);
        await take.point(thread.getByRole('paragraph').last(), {
          duration: 600,
          at: UNDER,
        });
      }),
    // Resolved: the thread folds to one line.
    '02b': () =>
      take.shot('02b', ms['02b'], async () => {
        await take.click(
          thread.getByRole('button', { name: ui.resolve, exact: true }),
        );
      }),
    // Approved, and ready to merge into main.
    '03a': () =>
      take.shot('03a', ms['03a'], async () => {
        await take.click(approve, { after: 400 });
        // Off the buttons (a tooltip would cover the panel), onto the approvals that now read
        // "approved" and "ready to merge".
        await take.point(approvals.getByRole('listitem').last(), {
          duration: 700,
          at: { x: 0.85, y: 1.6 },
        });
      }),
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
  if (!values['no-reset']) resetDemo(lang);
  const state = demoState(lang);
  const plan = narrationPlan('review', lang);
  const lengths = shotLengths(plan);
  console.log(
    `${plan.voiced ? 'timed from the voice' : 'timed from an estimate (no voice yet)'}: ${loopedSeconds(lengths)} s`,
  );
  const browser = await chromium.launch();
  try {
    const take = await Take.start(browser, {
      video: 'review',
      lang,
      user: 'reviewer',
      state,
      path: '/review',
    });
    await take.placeCursor(1180, 880);
    const shots = film(take, lengths);
    for (const id of SHOTS) {
      if (only.includes(id)) await shots[id]();
      else if (id === '01b')
        await take.page.locator('input[value="side"]').check({ force: true });
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
