import type { Page } from '@playwright/test';

/**
 * Chrome's own note that it skipped a page-to-page view transition (`@view-transition`): on a
 * loaded machine the new page is likely painted before the transition could be set up, so
 * Chrome drops the fade and logs this. The page still loaded and works; it is no error of ours.
 */
const SKIPPED_TRANSITION =
  'Transition was aborted because of invalid state. Page already revealed';

/**
 * The console errors and uncaught exceptions a page raises from now on, for a spec's
 * `afterEach` to expect none of (a blocked script or style under the Content Security Policy
 * is one).
 */
export const watchErrors = (page: Page): string[] => {
  const seen: string[] = [];
  const add = (text: string) => {
    if (text !== SKIPPED_TRANSITION) seen.push(text);
  };
  page.on('console', (m) => {
    if (m.type() === 'error') add(m.text());
  });
  page.on('pageerror', (e) => add(e.message));
  return seen;
};

/** The fixture sites' addresses (`global-setup.ts`). */
export const site = (audience: 'public' | 'internal' | 'plain', path = '') => {
  const url = process.env[`PORTAL_E2E_${audience.toUpperCase()}`];
  if (url === undefined)
    throw new Error('portal e2e: run through playwright.config.ts');
  return `${url}/${path}`;
};

/** A manual page of the public fixture site. */
export const OPERATING = (
  lang: string,
  variant = 'model=large,power=battery',
  product = 'alpha',
) => `${lang}/${product}/operating/${variant}/`;
