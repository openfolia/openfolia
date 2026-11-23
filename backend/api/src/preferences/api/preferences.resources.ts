import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import {
  MAX_DISMISSED_TIPS,
  type PreferenceChanges,
  type StoredPreferences,
  TipId,
} from '../core/preferences.js';

const ShowTips = z
  .boolean()
  .describe(
    'Whether the editor shows tips and the first-run tour ("Show tips" in the account menu). `true` by default.',
  );

const DismissedTips = z
  .array(TipId)
  .max(MAX_DISMISSED_TIPS)
  .describe(
    `The tips you have seen and closed, by ID: never shown again. At most ${MAX_DISMISSED_TIPS}; a change replaces the whole list (each ID kept once). Empty by default; "Reset tips" empties it.`,
  );

const TourDone = z
  .boolean()
  .describe(
    'Whether you finished or skipped the first-run tour; `false` brings it back. `false` by default.',
  );

export const PreferencesResource = resourceObject('Preferences', {
  attributes: z.object({
    showTips: ShowTips,
    dismissedTips: DismissedTips,
    tourDone: TourDone,
  }),
  meta: z.object({
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When they last changed; null: never (the defaults).'),
  }),
})
  .describe(
    'Your own preferences: the editor’s tips and first-run tour. `id` is your user ID (`service` for a service, which has the defaults and changes none).',
  )
  .meta({ id: 'PreferencesResource' });

export const PreferencesDocument = singleDocument(PreferencesResource).meta({
  id: 'PreferencesDocument',
});
export type PreferencesDocument = z.infer<typeof PreferencesDocument>;

export const UpdatePreferencesDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Preferences'),
      id: z
        .string()
        .optional()
        .describe('Your user ID, if given; another is refused.'),
      attributes: z
        .strictObject({
          showTips: ShowTips.optional(),
          dismissedTips: DismissedTips.optional(),
          tourDone: TourDone.optional(),
        })
        .describe('The preferences to change; left out stays.'),
    }),
  })
  .meta({ id: 'UpdatePreferencesDocument' });
export type UpdatePreferencesDocument = z.output<
  typeof UpdatePreferencesDocument
>;

/** The resource's ID: the user's own ID, `service` for a service. */
export const preferencesIdOf = (actor: Actor): string =>
  actor.kind === 'user' ? actor.id : 'service';

export function toPreferencesResource(
  actor: Actor,
  stored: StoredPreferences,
): z.infer<typeof PreferencesResource> {
  return {
    type: 'Preferences',
    id: preferencesIdOf(actor),
    attributes: {
      showTips: stored.preferences.showTips,
      dismissedTips: [...stored.preferences.dismissedTips],
      tourDone: stored.preferences.tourDone,
    },
    meta: { updatedAt: stored.updatedAt?.toISOString() ?? null },
  };
}

/** The body's attributes as the action takes them. */
export function toChanges(
  attributes: UpdatePreferencesDocument['data']['attributes'],
): PreferenceChanges {
  return {
    ...(attributes.showTips !== undefined && { showTips: attributes.showTips }),
    ...(attributes.dismissedTips !== undefined && {
      dismissedTips: attributes.dismissedTips,
    }),
    ...(attributes.tourDone !== undefined && { tourDone: attributes.tourDone }),
  };
}
