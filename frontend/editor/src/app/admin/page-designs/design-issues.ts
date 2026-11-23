import { translated, type TranslatedText } from '@openfolia/ui/i18n';

import type { DesignIssue } from './design-model';

/** The texts of the issue codes a design's check gives (`validatePageDesign`, the asset checks). */
const ISSUE_TEXTS: Readonly<Record<string, string>> = {
  'low-contrast': 'editor.admin.pageDesigns.issues.lowContrast',
  'fonts-not-confirmed': 'editor.admin.pageDesigns.issues.fontsNotConfirmed',
  'missing-cover-image': 'editor.admin.pageDesigns.issues.missingCoverImage',
  'missing-manufacturer': 'editor.admin.pageDesigns.issues.missingManufacturer',
  'missing-asset': 'editor.admin.pageDesigns.issues.missingAsset',
  'invalid-font': 'editor.admin.pageDesigns.issues.invalidFont',
  'unknown-preset': 'editor.admin.pageDesigns.issues.unknownPreset',
  'unknown-template': 'editor.admin.pageDesigns.issues.unknownTemplate',
  'unknown-region': 'editor.admin.pageDesigns.issues.unknownRegion',
  'unknown-placeholder': 'editor.admin.pageDesigns.issues.unknownPlaceholder',
  'unknown-language': 'editor.admin.pageDesigns.issues.unknownLanguage',
  'unknown-text-attribute':
    'editor.admin.pageDesigns.issues.unknownTextAttribute',
  'region-languages-differ':
    'editor.admin.pageDesigns.issues.regionLanguagesDiffer',
};

/**
 * An issue as the screen says it, by its stable code (never the API's English message); one the
 * screen does not know reads as a problem with its code and place.
 */
export function issueText(issue: DesignIssue): TranslatedText {
  const key = ISSUE_TEXTS[issue.code];
  if (key) return translated(key, { at: issue.at ?? '' });
  return translated('editor.admin.pageDesigns.issues.unknown', {
    code: issue.code,
    at: issue.at ?? '',
  });
}
