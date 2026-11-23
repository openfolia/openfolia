import type { TranslationState as BadgeState } from '@openfolia/ui/badges';

import type { Schema } from '../api';

/** A translation's state as the API says it (`GET /translations/status`). */
export type ApiTranslationState = Schema<'TranslationState'>;

/** The language badge's state for the API's (`of-language-badge`). */
export const BADGE_STATE: Readonly<Record<ApiTranslationState, BadgeState>> = {
  'up-to-date': 'up-to-date',
  outdated: 'outdated',
  missing: 'not-translated',
  'at-provider': 'at-agency',
};
