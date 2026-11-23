import {
  isPagePlaceholder,
  isPlaceholderKey,
  PLACEHOLDER_KEYS,
  type PlaceholderKey,
} from '@openfolia/content-model/core';

/**
 * A placeholder's name as a person reads it (#393), by its key: what the chip and the `{` menu
 * show ("Product version" for `product-version`).
 */
export const PLACEHOLDER_LABELS: Readonly<Record<PlaceholderKey, string>> = {
  title: 'editor.docEditor.placeholder.keys.title',
  subtitle: 'editor.docEditor.placeholder.keys.subtitle',
  product: 'editor.docEditor.placeholder.keys.product',
  variant: 'editor.docEditor.placeholder.keys.variant',
  'product-version': 'editor.docEditor.placeholder.keys.productVersion',
  language: 'editor.docEditor.placeholder.keys.language',
  release: 'editor.docEditor.placeholder.keys.release',
  date: 'editor.docEditor.placeholder.keys.date',
  'document-number': 'editor.docEditor.placeholder.keys.documentNumber',
  'revision-number': 'editor.docEditor.placeholder.keys.revisionNumber',
  audience: 'editor.docEditor.placeholder.keys.audience',
  'manufacturer-name': 'editor.docEditor.placeholder.keys.manufacturerName',
  'manufacturer-address':
    'editor.docEditor.placeholder.keys.manufacturerAddress',
  'manufacturer-contact':
    'editor.docEditor.placeholder.keys.manufacturerContact',
  'manufacturer-website':
    'editor.docEditor.placeholder.keys.manufacturerWebsite',
  chapter: 'editor.docEditor.placeholder.keys.chapter',
  page: 'editor.docEditor.placeholder.keys.page',
  'page-count': 'editor.docEditor.placeholder.keys.pageCount',
};

/**
 * The placeholders a title or back page region offers: every key but the page keys (the
 * chapter, the page number and the page count), which only a running header or footer fills in.
 */
export const REGION_PLACEHOLDER_KEYS: readonly PlaceholderKey[] =
  PLACEHOLDER_KEYS.filter((key) => !isPagePlaceholder(key));

/** A placeholder's label key, or null for a key that is no placeholder. */
export function placeholderLabel(key: string): string | null {
  return isPlaceholderKey(key) ? PLACEHOLDER_LABELS[key] : null;
}
