import { expect, type Page, test } from '@playwright/test';
import {
  DEAD_LINKS,
  INTERNAL_CANARY,
  INTERNAL_LINKS,
  OLDER_REVISIONS,
  START_MANUAL,
} from '../testing/fixture-repo.ts';
import { site } from './sites.ts';

/**
 * The authored start page (#897): the public and internal sites show the released manual named
 * by the build's setting, each for its audience; the `plain` site, whose release has no such
 * manual, keeps the default page. What no built file may hold is in `leaks.spec.ts`.
 */

const errors = new WeakMap<Page, string[]>();

test.beforeEach(({ page }) => {
  const seen: string[] = [];
  errors.set(page, seen);
  page.on('console', (message) => {
    if (message.type() === 'error') seen.push(message.text());
  });
  page.on('pageerror', (error) => seen.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  const sideways = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(sideways).toBeLessThanOrEqual(0);
});

const cards = (page: Page) => page.locator('.start-card');

test('without a released start page, the start page is the default one', async ({
  page,
}) => {
  await page.goto(site('plain', 'en/'));
  await expect(
    page.getByRole('heading', { level: 1, name: 'Documentation' }),
  ).toBeVisible();
  await expect(page.locator('.start__intro')).toHaveText(
    'Operating, service and safety manuals for every product, in the variant you have.',
  );
  await expect(page.locator('.start__authored')).toHaveCount(0);
  await expect(cards(page)).toHaveCount(0);
  await expect(page.locator('.start .manual-body')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 2, name: 'Alpha' }),
  ).toBeVisible();
});

test('its heading and introduction stand over the search field, its notice and links under it', async ({
  page,
}) => {
  await page.goto(site('public', 'en/'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Find the right page the first time',
  );
  const lead = page.getByText('Everything about operating and charging');
  const field = page.getByRole('combobox', { name: 'Search all manuals' });
  const notice = page.locator('.start .of-admonition');
  await expect(notice).toContainText('New in this release');
  await expect(
    page.getByRole('heading', { level: 2, name: /^Before the first start/ }),
  ).toBeVisible();
  const tops: number[] = [];
  for (const part of [
    page.getByRole('heading', { level: 1 }),
    lead,
    field,
    notice,
    cards(page).first(),
    page.locator('#product-alpha'),
  ])
    tops.push((await part.boundingBox())!.y);
  expect(tops).toEqual([...tops].sort((a, b) => a - b));

  // In the text, a cross-reference leads to its page; a link to a page that went is plain text.
  await expect(notice).toContainText('The old page has moved;');
  await expect(notice.getByRole('link')).toHaveText([
    'Charging',
    'manual',
    /^Before the first start/,
  ]);
  await expect(notice.getByRole('link', { name: 'manual' })).toHaveAttribute(
    'href',
    '/en/alpha/operating/model=small,power=battery/',
  );
  // To a section of the start page itself: it is there, and no two elements share an ID.
  const section = (await notice
    .getByRole('link', { name: /^Before the first start/ })
    .getAttribute('href'))!;
  await expect(page.locator(section)).toContainText('All manuals');
  const ids = await page
    .locator('[id]')
    .evaluateAll((all) => all.map((element) => element.id));
  expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  await notice.getByRole('link', { name: 'Charging', exact: true }).click();
  await expect(page).toHaveURL(
    /\/en\/(alpha|beta)\/operating\/.*#of-charging$/,
  );
});

test('its links are cards, each with its line and where it leads; none is broken', async ({
  page,
  request,
}) => {
  await page.goto(site('public', 'en/'));
  await expect(page.locator('.start-card__title')).toHaveText([
    'Charge the vehicle',
    'Operating manual',
    'Everything about the battery',
    'Spare parts and support',
    'Beta: the operating manual for the battery-powered small model, from unpacking to the first charge',
    'All manuals',
  ]);
  const featured = page.getByRole('list', { name: 'Featured links' });
  await expect(featured.getByRole('listitem')).toHaveCount(4);
  await expect(cards(page).first()).toContainText('At the dock or by hand');
  await expect(cards(page).nth(1).locator('.start-card__context')).toHaveText(
    'Alpha',
  );

  // Elsewhere, and said so; every other one opens a page of this site.
  const support = cards(page).nth(3);
  await expect(support).toHaveAttribute(
    'href',
    'https://support.example.org/parts',
  );
  await expect(support).toHaveAttribute('rel', /noopener/);
  await expect(support).toContainText('External link: support.example.org');
  for (const href of await cards(page).evaluateAll((links) =>
    links.map((link) => link.getAttribute('href')!),
  )) {
    if (href.startsWith('https://support.example.org/')) continue;
    expect(href).toMatch(/^\/en\//);
    const answer = await request.get(new URL(href, page.url()).href);
    expect(answer.status(), href).toBe(200);
  }

  // A section: its heading is there.
  await cards(page).first().click();
  await expect(page).toHaveURL(/#of-charging$/);
  await expect(page.locator('#of-charging')).toBeVisible();
  // A search: the results show.
  await page.goBack();
  await cards(page).nth(2).click();
  await expect(page).toHaveURL(site('public', 'en/search/?q=battery'));
  await expect(page.locator('.result').first()).toBeVisible();
});

test('in German it is the German page, its links too; a missing translation falls back, marked', async ({
  page,
}) => {
  await page.goto(site('public', 'de/'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Finden Sie die richtige Seite auf Anhieb',
  );
  const manual = cards(page).filter({ hasText: 'Betriebsanleitung' });
  await expect(manual).toHaveAttribute(
    'href',
    '/de/alpha/operating/model=large,power=mains/',
  );
  await expect(
    page.getByRole('list', { name: 'Empfohlene Links' }),
  ).toBeVisible();
  // A link in the text too, copied from the English site and without its variant.
  await expect(
    page
      .locator('.start')
      .getByRole('link', { name: 'Anleitung', exact: true }),
  ).toHaveAttribute('href', '/de/alpha/operating/model=small,power=battery/');
  const fallback = page.locator('.start__heading', {
    hasText: 'Before the first start',
  });
  await expect(fallback).toHaveAttribute('lang', 'en');
  // The language switch keeps the reader on the start page.
  await page.locator('.langs a[hreflang="en"]').click();
  await expect(page).toHaveURL(site('public', 'en/'));
});

test('nothing above the audience, and no link to a page that is not there', async ({
  page,
}) => {
  await page.goto(site('public', 'en/'));
  for (const title of [...INTERNAL_LINKS, ...DEAD_LINKS])
    await expect(page.getByText(title)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(INTERNAL_CANARY, {
    ignoreCase: true,
  });

  // The internal site has the first two, its own section, an update guide and an older release.
  await page.goto(site('internal', 'en/'));
  for (const title of INTERNAL_LINKS)
    await expect(cards(page).filter({ hasText: title })).toBeVisible();
  for (const title of DEAD_LINKS)
    await expect(page.getByText(title)).toHaveCount(0);
  await expect(
    page.getByRole('heading', { level: 2, name: /For service staff/ }),
  ).toBeVisible();
  const guide = cards(page).filter({ hasText: 'Update the software' });
  await expect(guide.locator('.kind-tag')).toHaveText('Update guide');
  await guide.click();
  await expect(page).toHaveURL(
    site('internal', 'en/alpha/software-update/?from=1.0&to=4.0'),
  );
  await expect(page.locator('[data-guide-from]')).toHaveValue('1.0');
  await expect(page.locator('[data-guide-to]')).toHaveValue('4.0');

  await page.goto(site('internal', 'en/'));
  await cards(page).filter({ hasText: 'The release before' }).click();
  await expect(page).toHaveURL(
    site('internal', `en/alpha/v/${OLDER_REVISIONS[0]}/`),
  );
  await expect(page.locator('.older-notice')).toBeVisible();
});

test('it is the start page alone: in no list, no search and at no address of its own', async ({
  page,
  request,
}) => {
  for (const path of ['en/', 'en/manuals/', 'en/alpha/v/0.8/']) {
    await page.goto(site('internal', path));
    // The internal one's ID starts with the public one's.
    await expect(page.locator(`a[href*="${START_MANUAL}"]`)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Start page' })).toHaveCount(0);
  }
  for (const audience of ['public', 'internal'] as const)
    for (const product of ['alpha', 'beta'])
      expect(
        (
          await request.get(site(audience, `en/${product}/${START_MANUAL}/`))
        ).status(),
      ).toBe(404);
  await page.goto(site('public', 'en/search/?q=first+time'));
  await expect(page.locator('[data-status]')).not.toBeEmpty();
  await expect(page.locator('.result a[href$="/en/"]')).toHaveCount(0);
});

test('the cards keep their place while the pointer and the focus pass over them', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(site('internal', 'en/'));
  const card = cards(page).first();
  await expect(card).toHaveCSS('transition-duration', /^0(\.0+1)?s|1e-0\ds/);
  const before = await card.boundingBox();
  await card.hover();
  expect(await card.boundingBox()).toEqual(before);
  await page.keyboard.press('Tab');
  await card.focus();
  expect(await card.boundingBox()).toEqual(before);
  expect(await card.evaluate((c) => getComputedStyle(c).outlineStyle)).not.toBe(
    'none',
  );
});
