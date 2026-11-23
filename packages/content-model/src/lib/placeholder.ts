/**
 * Placeholders (#390): the fixed data keys a page design's text (its title-page and back-page
 * regions, its running header and footer) can show, each an inline `placeholder` node, so it
 * survives round trips through AsciiDoc and the editor and stays whole in a translation. Schema-free,
 * for `@openfolia/content-model/core`.
 */

/**
 * Every placeholder key, the data a title page can show (#389: title, subtitle, product,
 * variant, product version, language, release, date, document number, revision number and
 * audience), the manufacturer's details from the configuration (#395: name, address, contact,
 * website) and what a running header or footer shows on each page (the chapter, the page
 * number and the page count). `release` and `date` are the release's name and date, known when a
 * release's PDF is made (#395): a preview leaves them as placeholders.
 */
export const PLACEHOLDER_KEYS = [
  'title',
  'subtitle',
  'product',
  'variant',
  'product-version',
  'language',
  'release',
  'date',
  'document-number',
  'revision-number',
  'audience',
  'manufacturer-name',
  'manufacturer-address',
  'manufacturer-contact',
  'manufacturer-website',
  'chapter',
  'page',
  'page-count',
] as const;
export type PlaceholderKey = (typeof PLACEHOLDER_KEYS)[number];

/**
 * The keys whose value changes from page to page: the renderer fills them in on each page, so
 * resolving a design keeps them as placeholder nodes.
 */
export const PAGE_PLACEHOLDER_KEYS: readonly PlaceholderKey[] = [
  'chapter',
  'page',
  'page-count',
];

/**
 * The keys whose value is a text attribute's of the same name, set per manual and variant in
 * the manifest (`attributes`): what the manual's data does not hold by itself. A project that
 * shows a document number configures a text attribute `document-number` and sets it per manual.
 */
export const ATTRIBUTE_PLACEHOLDER_KEYS: readonly PlaceholderKey[] = [
  'subtitle',
  'product',
  'product-version',
  'document-number',
  'revision-number',
];

/**
 * The keys whose value is the configuration's manufacturer details (#395, `manufacturer`): the
 * name, the address (its lines joined with commas), the contact and the website.
 */
export const MANUFACTURER_PLACEHOLDER_KEYS: readonly PlaceholderKey[] = [
  'manufacturer-name',
  'manufacturer-address',
  'manufacturer-contact',
  'manufacturer-website',
];

const KEYS: ReadonlySet<string> = new Set(PLACEHOLDER_KEYS);

/** Whether `key` is one of `PLACEHOLDER_KEYS`. */
export function isPlaceholderKey(key: unknown): key is PlaceholderKey {
  return typeof key === 'string' && KEYS.has(key);
}

/** Whether a placeholder's value is filled in per page by the renderer (`PAGE_PLACEHOLDER_KEYS`). */
export function isPagePlaceholder(key: string): boolean {
  return (PAGE_PLACEHOLDER_KEYS as readonly string[]).includes(key);
}

/**
 * A placeholder as plain text where it has no value (a module's text, which should hold none;
 * a preview of a design's text): its key in square brackets, `[document-number]`.
 */
export function placeholderText(key: string): string {
  return `[${key}]`;
}
