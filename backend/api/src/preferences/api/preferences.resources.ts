import { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import {
  CHOSEN_KINDS,
  type ChosenKind,
} from '../../notifications/core/notification.js';
import type { PreferencesView } from '../core/actions/get-preferences.action.js';
import {
  allChoices,
  DeliveryChoice,
  DigestHour,
  NotificationLanguage,
  TimeZone,
} from '../core/notification-settings.js';
import {
  MAX_DISMISSED_TIPS,
  type PreferenceChanges,
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

/** A choice per kind one is made about: every one in the response, any of them in a change. */
const choiceFields = Object.fromEntries(
  CHOSEN_KINDS.map((kind) => [kind, DeliveryChoice]),
) as Record<ChosenKind, typeof DeliveryChoice>;

const CHOICES_DESCRIPTION =
  'How each kind of notification reaches you: `off` (neither the bell nor email), `app` (the bell only), `email` (the bell and an email at once), `digest` (the bell and the daily summary email). Defaults: review requests and decisions on your changes `email`; a broken lock `app`; releases and translations `digest`; a release file that failed, a failed or overdue backup `email`. Nothing is chosen about the use of the emergency account (`sign-in.break-glass`): administrators are always told, in the bell and by email.';

const NotificationSettingsAttributes = z.object({
  choices: z.strictObject(choiceFields).describe(CHOICES_DESCRIPTION),
  emailPaused: z
    .boolean()
    .describe(
      '"Pause all email": every kind that would email stays in the app only, but a use of the emergency account. `false` by default.',
    ),
  allOff: z
    .boolean()
    .describe(
      '"Turn off all notifications": nothing reaches you, neither the bell nor email, but a use of the emergency account. `false` by default.',
    ),
  digestHour: DigestHour.nullable().describe(
    'The hour (0 to 23, in `timeZone`) the daily summary goes out; null: the installation’s (`meta.notifications.defaultDigestHour`).',
  ),
  timeZone: TimeZone.nullable().describe(
    'Your time zone (IANA, `Europe/Vienna`); null: UTC. The editor sets it from your browser.',
  ),
  language: NotificationLanguage.nullable().describe(
    'The language of your email (`en`, `de`); null: the installation’s. The editor sets it to your interface language.',
  ),
});

export const PreferencesResource = resourceObject('Preferences', {
  attributes: z.object({
    showTips: ShowTips,
    dismissedTips: DismissedTips,
    tourDone: TourDone,
    notifications: NotificationSettingsAttributes.describe(
      'Which notifications reach you, and how (#884).',
    ),
  }),
  meta: z.object({
    updatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When they last changed; null: never (the defaults).'),
    notifications: z.object({
      emailUnavailable: z
        .enum(['off', 'no-secret-key', 'no-public-url', 'no-address'])
        .nullable()
        .describe(
          'Why no notification email can reach you: the installation sends no email (`off`), has no secret key (`no-secret-key`) or no public address to link to (`no-public-url`), or you have no email address (`no-address`); null when it can. Nothing is emailed meanwhile.',
        ),
      defaultDigestHour: DigestHour.describe(
        'The summary’s hour for someone who chose none (`CCMS_NOTIFICATIONS_DIGEST_HOUR`).',
      ),
    }),
  }),
})
  .describe(
    'Your own preferences: the editor’s tips and first-run tour, and your notifications. `id` is your user ID (`service` for a service, which has the defaults and changes none).',
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
          notifications: z
            .strictObject({
              choices: z
                .strictObject(choiceFields)
                .partial()
                .optional()
                .describe(
                  `${CHOICES_DESCRIPTION} Only the kinds given change.`,
                ),
              emailPaused:
                NotificationSettingsAttributes.shape.emailPaused.optional(),
              allOff: NotificationSettingsAttributes.shape.allOff.optional(),
              digestHour:
                NotificationSettingsAttributes.shape.digestHour.optional(),
              timeZone:
                NotificationSettingsAttributes.shape.timeZone.optional(),
              language:
                NotificationSettingsAttributes.shape.language.optional(),
            })
            .optional()
            .describe('The notification settings to change; left out stays.'),
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
  view: PreferencesView,
): z.infer<typeof PreferencesResource> {
  const n = view.preferences.notifications;
  return {
    type: 'Preferences',
    id: preferencesIdOf(actor),
    attributes: {
      showTips: view.preferences.showTips,
      dismissedTips: [...view.preferences.dismissedTips],
      tourDone: view.preferences.tourDone,
      notifications: {
        choices: allChoices(n),
        emailPaused: n.emailPaused,
        allOff: n.allOff,
        digestHour: n.digestHour,
        timeZone: n.timeZone,
        language: n.language,
      },
    },
    meta: {
      updatedAt: view.updatedAt?.toISOString() ?? null,
      notifications: {
        emailUnavailable: view.email.unavailable,
        defaultDigestHour: view.defaultDigestHour,
      },
    },
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
    ...(attributes.notifications !== undefined && {
      notifications: attributes.notifications,
    }),
  };
}
