import type { TranslatedText } from '@openfolia/ui/i18n';

import type { ApiError, ApiErrorObject } from '../../api';
import { apiErrorText } from '../../i18n';
import type { BrandingFields } from '../../branding/branding-model';

/** The contrast pairs the API checks (`meta.pair`), with their texts. */
export const PAIR_TEXTS: Readonly<Record<string, string>> = {
  'primary/background': 'editor.admin.branding.pairs.primaryOnPage',
  'primary/card': 'editor.admin.branding.pairs.primaryOnCard',
  'primary/sidebar': 'editor.admin.branding.pairs.primaryOnSidebar',
  'primary-foreground/primary': 'editor.admin.branding.pairs.textOnPrimary',
  'foreground/accent': 'editor.admin.branding.pairs.textOnHighlight',
  'sidebar-foreground/sidebar': 'editor.admin.branding.pairs.textOnSidebar',
  'muted-foreground/sidebar': 'editor.admin.branding.pairs.mutedOnSidebar',
};

/** The upload and change refusals the branding screen words itself. */
const CODES: Readonly<Record<string, string>> = {
  'unsupported-image-type': 'editor.admin.branding.errors.imageType',
  'too-large': 'editor.admin.branding.errors.tooLarge',
  'image-too-large': 'editor.admin.branding.errors.tooManyPixels',
  'animated-image': 'editor.admin.branding.errors.animated',
  'too-many-uploads': 'editor.admin.branding.errors.tooManyImages',
  'unknown-image': 'editor.admin.branding.errors.unknownImage',
  'image-not-square': 'editor.admin.branding.errors.notSquare',
};

/** The field an error object names (`source.pointer` `/data/attributes/<field>`), if any. */
export function fieldOf(error: ApiErrorObject): keyof BrandingFields | null {
  const match = /^\/data\/attributes\/(\w+)$/.exec(error.source?.pointer ?? '');
  return (match?.[1] as keyof BrandingFields | undefined) ?? null;
}

/**
 * One error object in words: the pair and ratio for a contrast refusal (`params.pair` is the
 * pair's own key, for the caller to translate in place), the size for a shape.
 */
export function brandingErrorObjectText(
  error: ApiErrorObject,
): TranslatedText | null {
  const meta = error.meta ?? {};
  if (error.code === 'insufficient-contrast') {
    return {
      key:
        meta['theme'] === 'dark'
          ? 'editor.admin.branding.errors.contrastDark'
          : 'editor.admin.branding.errors.contrastLight',
      params: {
        pair:
          PAIR_TEXTS[String(meta['pair'])] ??
          'editor.admin.branding.pairs.other',
        ratio: meta['ratio'],
        required: meta['required'],
      },
    };
  }
  const key = CODES[error.code ?? ''];
  return key ? { key, params: { ...meta } } : null;
}

/** A failed change or upload in words: its first error of the branding's, else the API's text. */
export function brandingErrorText(error: ApiError): TranslatedText {
  const [first] = error.errors;
  if (first?.code === 'insufficient-contrast') {
    return { key: 'editor.admin.branding.errors.contrast' };
  }
  return (first && brandingErrorObjectText(first)) ?? apiErrorText(error);
}

/** The errors of a refusal by the field they name. */
export function fieldErrors(
  error: ApiError,
): Partial<Record<keyof BrandingFields, TranslatedText>> {
  const byField: Partial<Record<keyof BrandingFields, TranslatedText>> = {};
  for (const object of error.errors) {
    const field = fieldOf(object);
    const text = brandingErrorObjectText(object);
    if (field && text && !byField[field]) byField[field] = text;
  }
  return byField;
}
