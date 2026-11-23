/** The fixture sites' addresses (`global-setup.ts`). */
export const site = (audience: 'public' | 'internal', path = '') => {
  const url = process.env[`PORTAL_E2E_${audience.toUpperCase()}`];
  if (url === undefined)
    throw new Error('portal e2e: run through playwright.config.ts');
  return `${url}/${path}`;
};

/** A manual page of the public fixture site. */
export const OPERATING = (
  lang: string,
  variant = 'model=large',
  product = 'alpha',
) => `${lang}/${product}/operating/${variant}/`;
