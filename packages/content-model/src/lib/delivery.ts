import type { ProjectConfig } from './config.js';

/**
 * Who may open a manual's stable address (`/d/<product>/<manual>/<variant>/<lang>`, #450):
 * `public` (anyone, no sign-in), `signed-in` (a reader with `content.read`) or `off` (nobody).
 */
export const DELIVERY_ACCESS = ['public', 'signed-in', 'off'] as const;
export type DeliveryAccess = (typeof DELIVERY_ACCESS)[number];
export const DEFAULT_DELIVERY_ACCESS: DeliveryAccess = 'signed-in';

/**
 * What a stable address in a language the release does not have opens: `picker`, a page
 * listing the languages it has, or `source`, the same address in the source language.
 */
export const MISSING_LANGUAGE = ['picker', 'source'] as const;
export type MissingLanguage = (typeof MISSING_LANGUAGE)[number];
export const DEFAULT_MISSING_LANGUAGE: MissingLanguage = 'picker';

/**
 * Where a release's PDF prints the QR code of its stable address: `none`, on the
 * `title-page` or on a `back-cover` page of its own at the end.
 */
export const PDF_QR_CODE = ['none', 'title-page', 'back-cover'] as const;
export type PdfQrCode = (typeof PDF_QR_CODE)[number];
export const DEFAULT_PDF_QR_CODE: PdfQrCode = 'none';

/** The most former addresses one manual keeps. */
export const MAX_FORMER_ADDRESSES = 20;

type Delivery = Pick<ProjectConfig, 'delivery'>;

/** A manual's address segment: its configured `slug`, else its ID. */
export function deliverySlug(config: Delivery, manualId: string): string {
  return config.delivery.manuals[manualId]?.slug ?? manualId;
}

/**
 * What an address segment names (#450): the manual whose configured `slug` it is (`current`);
 * else the manual whose `formerly` lists it (`former`: the address moved, and the reader is sent
 * to the current one); else a manual of that ID, `former` too when that manual has a slug of its
 * own (its address is the slug). A configured slug wins over a manual's ID.
 */
export function manualOfSlug(
  config: Delivery,
  slug: string,
): { readonly manualId: string; readonly moved: boolean } {
  const entries = Object.entries(config.delivery.manuals);
  const bySlug = entries.find(([, entry]) => entry.slug === slug);
  if (bySlug) return { manualId: bySlug[0], moved: false };
  const former = entries.find(([, entry]) => entry.formerly.includes(slug));
  if (former) return { manualId: former[0], moved: true };
  const own = config.delivery.manuals[slug];
  return {
    manualId: slug,
    moved: own?.slug !== undefined && own.slug !== slug,
  };
}

/**
 * The manual IDs a release may hold the manual under, newest first: its ID, then each of its
 * former addresses (an old release holds a renamed manual under its old ID).
 */
export function manualIdsOf(config: Delivery, manualId: string): string[] {
  const formerly = config.delivery.manuals[manualId]?.formerly ?? [];
  return [manualId, ...formerly.filter((id) => id !== manualId)];
}

/**
 * The audience level a public address serves (`delivery.publicAudience`, else the least
 * restricted level): the most restricted one a reader without sign-in reads.
 */
export function publicAudience(
  config: Delivery & Pick<ProjectConfig, 'audiences'>,
): string | undefined {
  return config.delivery.publicAudience ?? config.audiences[0]?.id;
}
