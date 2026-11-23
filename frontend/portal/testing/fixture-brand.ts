import sharp from 'sharp';
import type { FixtureBranding } from './fixture-api.ts';

/** The fixture's invented brand (#784): its name and a primary colour that is not the default green. */
export const BRAND_NAME = 'Corvel';
export const BRAND_PRIMARY = '#1d4f91';

/** Shapes only (no text, so no font decides the pixels), drawn to PNG as an administrator would upload them. */
const mark = (a: string, b: string) =>
  `<path d="M14 6h20l-8 36H6z" fill="${a}"/><path d="M34 6h14l-8 36H26z" fill="${b}"/>`;
const logo = (ink: string, a: string, b: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="48">${mark(a, b)}<rect x="64" y="14" width="150" height="20" rx="4" fill="${ink}"/></svg>`;
const png = (svg: string) => sharp(Buffer.from(svg)).png().toBuffer();

export async function fixtureBranding(): Promise<FixtureBranding> {
  return {
    productName: BRAND_NAME,
    logoLight: await png(logo('#1b2430', BRAND_PRIMARY, '#6f9bd6')),
    logoDark: await png(logo('#ffffff', '#7bb0fa', '#c9dcf7')),
    favicon: await png(
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="${BRAND_PRIMARY}"/><g transform="translate(4 8)">${mark('#ffffff', '#9cc0f0')}</g></svg>`,
    ),
    primary: BRAND_PRIMARY,
  };
}
