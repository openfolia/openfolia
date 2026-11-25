// What the demo needs beyond the content repository, made through the API as the demo people,
// the way the films will show it (#441):
//
//   1. release 1.0 of the product;
//   2. a change merged after it (the fully loaded estate's rear tyre pressure raised, in English
//      and German, the German translation marked current), and release 1.1, so "what changed"
//      has an answer, and each estate PDF of the owner's manual and the service booklet shows the
//      new value;
//   3. an open change set in review: changing a wheel revised (in English, and for a German take
//      in German too), with the reviewer's comments on its steps and one reply from the author.
//
// First of all, every demo person's first-run tour counts as skipped and their tips as off, so no
// tip or tour card (#222) covers a take or a still.
//
// The texts the API stores (change set titles, release notes, comments) are in the take's
// language, so a German film shows German throughout. Every request checks its answer: a broken
// set-up fails where it broke.

import { DEMO_PEOPLE } from './people.mjs';
import { PRODUCT } from './content.mjs';

const MEDIA_TYPE = 'application/vnd.api+json';

/** The texts the demo writes through the API, per take language (English for any other). */
const TEXTS = {
  en: {
    release1: 'First release of the owner documentation for the Fenna.',
    fixTitle: 'Raise the rear tyre pressure of the fully loaded estate',
    release2: 'Higher rear tyre pressure for the fully loaded estate.',
    reviewTitle: 'Revise changing a wheel',
    submit:
      'Ready for review: a gentler first turn, and the bolts checked after the change.',
    comments: [
      {
        block: 'step-loosen',
        body: 'Half a turn sounds little for a tight bolt. Is it enough to free it?',
        reply:
          'Yes: the brace has a long lever, and half a turn keeps the wheel from shifting on the hub. I will leave it.',
      },
      {
        block: 'step-retighten',
        body: 'Can owners check 120 Nm themselves? Perhaps say "at the next workshop" instead.',
      },
    ],
  },
  de: {
    release1: 'Erste Veröffentlichung der Betriebsanleitungen für den Fenna.',
    fixTitle: 'Reifendruck hinten beim voll beladenen Kombi erhöhen',
    release2: 'Höherer Reifendruck hinten für den voll beladenen Kombi.',
    reviewTitle: 'Rad wechseln überarbeiten',
    submit:
      'Bereit zur Prüfung: eine vorsichtigere erste Umdrehung, und die Radschrauben werden nach dem Wechsel geprüft.',
    comments: [
      {
        block: 'step-loosen',
        body: 'Eine halbe Umdrehung klingt wenig für eine festsitzende Schraube. Reicht das, um sie zu lösen?',
        reply:
          'Ja: Der Radschlüssel hat einen langen Hebel, und eine halbe Umdrehung verhindert, dass das Rad auf der Nabe verrutscht. Ich lasse es so.',
      },
      {
        block: 'step-retighten',
        body: 'Können Besitzer 120 Nm selbst prüfen? Vielleicht besser „in der nächsten Werkstatt“.',
      },
    ],
  },
};

/** The content's translations: every change the demo merges keeps them current. */
export const TRANSLATIONS = ['de', 'fr'];

/** A text run, and one marked as a glossary term. */
const text = (value) => ({ type: 'text', text: value });
const term = (value, termId) => ({
  type: 'text',
  text: value,
  marks: [{ type: 'term', termId }],
});

/**
 * The revised wheel change, per language: block ID to its new text, and a new last step (which
 * the Releases video marks in a PDF).
 */
export const REVISION = {
  en: {
    texts: {
      'step-loosen': [
        text('Loosen the '),
        term('wheel bolts', 'wheel-bolt'),
        text(
          ' by half a turn with the wheel brace while the wheel is still on the ground.',
        ),
      ],
      after:
        'Check the pressure of the spare wheel at the next filling station, and have the damaged tyre repaired or replaced.',
    },
    step: 'After 50 km, have the wheel bolts tightened to 120 Nm.',
  },
  de: {
    texts: {
      'step-loosen': [
        text('Lösen Sie die '),
        term('Radschrauben', 'wheel-bolt'),
        text(
          ' mit dem Radschlüssel um eine halbe Umdrehung, solange das Rad noch auf dem Boden steht.',
        ),
      ],
      after:
        'Prüfen Sie den Druck des Reserverads an der nächsten Tankstelle und lassen Sie den beschädigten Reifen reparieren oder ersetzen.',
    },
    step: 'Lassen Sie die Radschrauben nach 50 km mit 120 Nm nachziehen.',
  },
  fr: {
    texts: {
      'step-loosen': [
        text('Desserrez les '),
        term('boulons de roue', 'wheel-bolt'),
        text(
          " d'un demi-tour avec la clé de roue tant que la roue est encore au sol.",
        ),
      ],
      after:
        'Vérifiez la pression de la roue de secours à la prochaine station-service et faites réparer ou remplacer le pneu endommagé.',
    },
    step: 'Après 50 km, faites resserrer les boulons de roue à 120 Nm.',
  },
};

/** The fully loaded estate's rear tyre pressure, raised: per language, as each writes numbers. */
const TYRE_PRESSURE = {
  en: { 'es-full-rear': '3.1 bar' },
  de: { 'es-full-rear': '3,1 bar' },
  fr: { 'es-full-rear': '3,1 bar' },
};

/** A client of the demo API acting as one of the demo people (demo mode's `X-Ccms-User`). */
export class Client {
  constructor(apiUrl, token, person) {
    this.apiUrl = apiUrl;
    this.token = token;
    this.person = person;
  }

  async request(method, path, body, expected = [200, 201]) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Ccms-User': this.person.id,
        Accept: MEDIA_TYPE,
        ...(method !== 'GET' && { 'Content-Type': MEDIA_TYPE }),
      },
      body:
        method === 'GET'
          ? undefined
          : body === undefined
            ? ''
            : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!expected.includes(response.status)) {
      throw new Error(
        `${this.person.id}: ${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    return text ? JSON.parse(text) : undefined;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body, expected) {
    return this.request('POST', path, body, expected);
  }

  patch(path, body, expected = [200]) {
    return this.request('PATCH', path, body, expected);
  }

  async changeSet(title) {
    const { data } = await this.post('/change-sets', {
      data: { type: 'ChangeSet', attributes: { title } },
    });
    return data.id;
  }

  /** Locks a module in the change set, changes its working copy with `change`, saves it. */
  async editModule(changeSet, lang, moduleId, change) {
    await this.post(`/change-sets/${changeSet}/locks`, {
      data: {
        type: 'Lock',
        attributes: { subject: { type: 'module', lang, moduleId } },
      },
    });
    const path = `/change-sets/${changeSet}/modules/${lang}/${moduleId}/working-copy`;
    const { data } = await this.get(path);
    await this.request('PUT', path, {
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: change(structuredClone(data.attributes.content)),
        },
      },
      meta: {
        version: data.attributes.version,
        baseCommit: data.attributes.baseCommit,
      },
    });
  }

  /** Marks a module's translation into `lang` current with its source, in the change set. */
  markCurrent(changeSet, moduleId, lang) {
    return this.post(
      '/translations/mark-current',
      {
        data: {
          type: 'TranslationMarkCurrent',
          attributes: { changeSetId: changeSet, moduleId, lang },
        },
      },
      [200, 201],
    );
  }

  savePoint(changeSet) {
    return this.post(`/change-sets/${changeSet}/commits`, undefined, [201]);
  }

  transition(changeSet, name, comment) {
    return this.post(
      `/change-sets/${changeSet}/${name}`,
      comment === undefined ? undefined : { meta: { comment } },
      [200],
    );
  }

  async release(revision, notes, notesByLanguage) {
    const { data } = await this.post(
      '/releases',
      {
        data: {
          type: 'Release',
          attributes: { product: PRODUCT, revision, notes, notesByLanguage },
        },
      },
      [201],
    );
    return data.id;
  }
}

/**
 * Replaces the inline content of the blocks (or items, steps, cells) named in `texts`: a string
 * is one text run, an array the runs themselves.
 */
export function withTexts(node, texts) {
  if (Array.isArray(node)) return node.map((child) => withTexts(child, texts));
  if (node === null || typeof node !== 'object') return node;
  const copy = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, withTexts(value, texts)]),
  );
  if (typeof node.id === 'string' && Object.hasOwn(texts, node.id)) {
    if (!Array.isArray(node.content)) {
      throw new Error(`block ${node.id} has no inline content to replace`);
    }
    const value = texts[node.id];
    copy.content = Array.isArray(value) ? value : [text(value)];
  }
  return copy;
}

/** The raised tyre pressure in one language's tyre pressure module. */
export function raiseTyrePressure(module, lang) {
  return withTexts(module, TYRE_PRESSURE[lang] ?? TYRE_PRESSURE.en);
}

/** The wheel change revised: new wording, and a last step to have the bolts tightened. */
export function reviseWheelChange(module, lang) {
  const revision = REVISION[lang] ?? REVISION.en;
  const revised = withTexts(module, revision.texts);
  const procedure = revised.blocks.find((block) => block.id === 'steps');
  if (!procedure?.steps?.some((step) => step.id === 'step-lower')) {
    throw new Error('the wheel change has no step-lower');
  }
  procedure.steps.push({
    id: 'step-retighten',
    content: [text(revision.step)],
    blocks: [],
  });
  return revised;
}

/**
 * The preferences a demo person starts with in the films (#222, `PATCH /me/preferences`): the
 * first-run tour done, as the editor stores it when the person skips it, and the tips off, so no
 * tip or tour card appears on a screen the films show.
 */
export const TIPS_SEEN = { tourDone: true, showTips: false };

/**
 * The preferences a demo person starts with in a public sandbox (#868, `bake.mjs`): a first
 * visit, so the tour opens on a visitor's first screen and the tips follow it.
 */
export const TIPS_FIRST_VISIT = { tourDone: false, showTips: true };

/** Sets the tips and the tour to `tips` for every demo person, each as themself. */
export async function markTipsSeen({ apiUrl, token, tips = TIPS_SEEN }) {
  for (const person of Object.values(DEMO_PEOPLE)) {
    const { data } = await new Client(apiUrl, token, person).patch(
      '/me/preferences',
      { data: { type: 'Preferences', attributes: tips } },
    );
    const { tourDone, showTips } = data.attributes;
    if (tourDone !== tips.tourDone || showTips !== tips.showTips) {
      throw new Error(`${person.id}: the tips are not marked as asked`);
    }
  }
}

/** A release's outputs are settled: planned, and none queued or rendering. */
export const outputsSettled = (state) => state === 'done' || state === 'failed';

/**
 * Waits until each release's outputs are settled (its `meta.outputs.state`, which tells planning
 * apart from rendering, so a release whose outputs are not listed yet is still waited for), so
 * the films' release screens show finished PDFs. Resolves to each release's outputs summary.
 */
export async function waitForOutputs(
  client,
  releases,
  timeoutMs,
  log,
  pauseMs = 2_000,
) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const outputs = {};
    for (const release of releases) {
      const { data } = await client.get(`/releases/${release}`);
      outputs[data.attributes.revision ?? release] = data.meta?.outputs ?? {};
    }
    const states = Object.values(outputs).map((summary) => summary.state);
    if (states.every(outputsSettled)) return outputs;
    if (Date.now() > end) {
      log(`release files not ready yet: ${JSON.stringify(outputs)}`);
      return outputs;
    }
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

/**
 * Makes the demo's state through the API at `apiUrl` (demo mode, `token`). `lang` is the take's
 * language: what the API stores as text is written in it. `tips`: the people's tips and tour
 * (`TIPS_SEEN` for the films, `TIPS_FIRST_VISIT` for a sandbox). Resolves to the IDs the films use.
 */
export async function populate({
  apiUrl,
  token,
  lang = 'en',
  log = () => undefined,
  outputsTimeoutMs = 300_000,
  tips = TIPS_SEEN,
}) {
  const texts = TEXTS[lang] ?? TEXTS.en;
  const author = new Client(apiUrl, token, DEMO_PEOPLE.author);
  const reviewer = new Client(apiUrl, token, DEMO_PEOPLE.reviewer);
  const admin = new Client(apiUrl, token, DEMO_PEOPLE.admin);

  log(
    tips.tourDone ? 'the tips and the tour marked as seen' : 'the tour to come',
  );
  await markTipsSeen({ apiUrl, token, tips });

  log('release 1.0');
  const first = await admin.release('1.0', TEXTS.en.release1, {
    de: TEXTS.de.release1,
  });

  log('a corrected value, merged');
  const fix = await admin.changeSet(texts.fixTitle);
  for (const moduleLang of ['en', ...TRANSLATIONS]) {
    await admin.editModule(fix, moduleLang, 'tyre-pressures', (content) =>
      raiseTyrePressure(content, moduleLang),
    );
  }
  await admin.savePoint(fix);
  // The translated values were changed with the English one: the translations are current.
  for (const lang of TRANSLATIONS) {
    await admin.markCurrent(fix, 'tyre-pressures', lang);
  }
  await admin.transition(fix, 'submit', texts.fixTitle);
  await reviewer.transition(fix, 'approve');
  await admin.transition(fix, 'merge');

  log('release 1.1');
  const second = await admin.release('1.1', TEXTS.en.release2, {
    de: TEXTS.de.release2,
  });

  log('a revision in review, with comments');
  const review = await author.changeSet(texts.reviewTitle);
  // An English take revises the source only (its German translation then waits, outdated); a
  // German take shows the German text first, so the author revises both.
  for (const moduleLang of lang === 'de' ? ['en', 'de'] : ['en']) {
    await author.editModule(review, moduleLang, 'changing-a-wheel', (m) =>
      reviseWheelChange(m, moduleLang),
    );
  }
  await author.savePoint(review);
  await author.transition(review, 'submit', texts.submit);
  const commentLang = lang === 'de' ? 'de' : 'en';
  for (const comment of texts.comments) {
    const { data } = await reviewer.post(
      `/change-sets/${review}/comments`,
      {
        data: {
          type: 'Comment',
          attributes: {
            body: comment.body,
            subject: {
              type: 'module',
              lang: commentLang,
              moduleId: 'changing-a-wheel',
            },
            blockId: comment.block,
          },
        },
      },
      [201],
    );
    if (comment.reply) {
      await author.post(
        `/change-sets/${review}/comments`,
        {
          data: {
            type: 'Comment',
            attributes: { body: comment.reply },
            relationships: {
              thread: { data: { type: 'Comment', id: data.id } },
            },
          },
        },
        [201],
      );
    }
  }

  log('waiting for the release files');
  const outputs = await waitForOutputs(
    admin,
    [first, second],
    outputsTimeoutMs,
    log,
  );
  return { releases: [first, second], fix, review, outputs };
}
