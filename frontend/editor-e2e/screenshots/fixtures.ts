import {
  expect,
  test as base,
  type Locator,
  type Page,
} from '@playwright/test';
import { Api, paragraph, USERS, type Block, type UserId } from '../src/api.ts';
import { signIn, tipsOff } from '../src/fixtures.ts';
import { label } from './labels.ts';
import { shot } from './shot.ts';

// What every file of the user guide's screenshots (`*.shots.ts`; README.md, "Screenshots for the
// user guide") shares: the fixture `test` (the run's language, its labels, `save` and `as`), the
// guide's example texts and its module. Each shot makes the state it shows through the API, on
// the screenshots' own stack, signs in as a demo user, opens the screen and writes one image. The
// revisions a shot starts are abandoned after it, so the next one finds every module free.

/** The guide's example texts, per language. */
export const TEXT = {
  en: {
    revision: 'Update the battery instructions',
    other: 'Clarify the charging times',
    module: 'Replace the battery',
    intro: 'Replace the battery when a charge no longer lasts a full shift.',
    hazard: 'Heavy battery',
    consequence: 'The battery can crush your fingers.',
    procedure: 'Replace the battery',
    steps: [
      'Switch off the machine.',
      'Open the battery cover.',
      'Lift out the old battery and put in the new one.',
    ],
    large: 'The large model has two batteries. Replace both.',
    newModule: 'Clean the sensors',
    leaflet: 'Safety leaflet for service staff',
    guide: 'Firmware update guide',
    search: 'charg',
    mainChange: 'Keep the housing closed while the machine runs.',
  },
  de: {
    revision: 'Batterieanleitung aktualisieren',
    other: 'Ladezeiten präzisieren',
    module: 'Batterie wechseln',
    intro:
      'Wechseln Sie die Batterie, wenn eine Ladung nicht mehr für eine ganze Schicht reicht.',
    hazard: 'Schwere Batterie',
    consequence: 'Die Batterie kann Ihre Finger quetschen.',
    procedure: 'Batterie wechseln',
    steps: [
      'Schalten Sie die Maschine aus.',
      'Öffnen Sie die Batterieabdeckung.',
      'Heben Sie die alte Batterie heraus und setzen Sie die neue ein.',
    ],
    large: 'Das große Modell hat zwei Batterien. Wechseln Sie beide.',
    newModule: 'Sensoren reinigen',
    leaflet: 'Sicherheitsblatt für das Servicepersonal',
    guide: 'Firmware-Update-Leitfaden',
    search: 'lad',
    mainChange:
      'Lassen Sie das Gehäuse geschlossen, solange die Maschine läuft.',
  },
} as const;
export type Text = (typeof TEXT)['en'] | (typeof TEXT)['de'];

/** The guide's module ID: the same in every shot, as each revision is abandoned after it. */
export const MODULE_ID = 'replace-battery';

export interface Revision {
  readonly id: string;
  readonly baseCommit: string;
}

export interface Shots {
  /** The UI language of this run: `en` or `de`. */
  lang: string;
  /** The guide's texts in this run's language. */
  text: Text;
  /** The editor's text for a translation key, in this run's language. */
  l: (key: string, params?: Record<string, string>) => string;
  /** Writes the page (or one element of it) as the guide's image `name`. */
  save: (name: string, target?: Page | Locator) => Promise<void>;
  /** An API client acting as `user`; the revisions it starts are abandoned after the shot. */
  as: (user: UserId) => Promise<Api>;
}

export const test = base.extend<Shots>({
  // Playwright reads a fixture's dependencies from this pattern, so it stays an empty object.
  // eslint-disable-next-line no-empty-pattern
  lang: async ({}, use, info) => use(info.project.name),
  text: async ({ lang }, use) => use(lang === 'de' ? TEXT.de : TEXT.en),
  l: async ({ lang }, use) => use((key, params) => label(lang, key, params)),
  save: async ({ page, browser, lang }, use) =>
    use(async (name, target = page) => {
      // Nothing loading, the pointer out of the way.
      await page.mouse.move(1279, 799);
      await page
        .waitForLoadState('networkidle', { timeout: 10_000 })
        .catch(() => undefined);
      await page.waitForTimeout(500);
      await shot(browser, target, lang, name);
    }),
  // eslint-disable-next-line no-empty-pattern
  as: async ({}, use) => {
    const made: Api[] = [];
    await use(async (user) => {
      const api = await Api.as(user);
      made.push(api);
      return api;
    });
    for (const api of made) {
      await api.cleanUp();
      await api.dispose();
    }
  },
  page: async ({ page, lang }, use) => {
    // No tip or tour over the shots (#222); the tips' own shots open them themselves.
    await tipsOff(page);
    await page.addInitScript((l) => {
      localStorage.setItem('of-language', l);
      localStorage.setItem('of-theme', 'light');
    }, lang);
    await use(page);
  },
});

export const t = (text: string) => ({ type: 'text', text });

/** The guide's module: an intro, a safety notice, a procedure and a block only for the large model. */
export function guideBlocks(text: Text): Block[] {
  return [
    paragraph('intro', text.intro),
    {
      type: 'safety',
      id: 'heavy',
      severity: 'warning',
      hazard: [t(text.hazard)],
      symbols: ['w001'],
      blocks: [paragraph('heavy-consequence', text.consequence)],
    },
    {
      type: 'procedure',
      id: 'steps',
      title: [t(text.procedure)],
      steps: text.steps.map((step, i) => ({
        id: `step-${i + 1}`,
        content: [t(step)],
        blocks: [],
      })),
    },
    {
      type: 'variant',
      id: 'large-only',
      when: { op: 'in', attr: 'model', values: ['large'] },
      blocks: [paragraph('large-text', text.large)],
    },
  ];
}

/**
 * A revision started by `api` holding the guide's module in English, and in the shot's language
 * too when that is another, with a save point.
 */
export async function revisionWithModule(
  api: Api,
  lang: string,
  title: string,
): Promise<Revision> {
  const revision = await api.createChangeSet(title);
  await api.createModule(
    revision,
    {
      lang: 'en',
      moduleId: MODULE_ID,
      title: TEXT.en.module,
      type: 'procedure',
      blocks: guideBlocks(TEXT.en),
    },
    { savePoint: lang === 'en' },
  );
  if (lang === 'de')
    await api.createModule(revision, {
      lang,
      moduleId: MODULE_ID,
      title: TEXT.de.module,
      type: 'procedure',
      blocks: guideBlocks(TEXT.de),
    });
  return revision;
}

/** Opens module `moduleId` in a revision and waits until the editor took its lock. */
export async function openModule(
  page: Page,
  path: string,
  heading: string,
): Promise<void> {
  const locked = page.waitForResponse(
    (r) => r.url().includes('/locks') && r.request().method() === 'POST',
  );
  await page.goto(path);
  await locked;
  await expect(
    page.getByRole('heading', { level: 1, name: heading }),
  ).toBeVisible();
}

export { Api, expect, paragraph, signIn, USERS };
export type { Block, UserId };
