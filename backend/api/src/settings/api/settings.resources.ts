import { z } from 'zod';
import { UserId } from '../../access/core/actor.js';
import { SECOND_FACTOR_RULES } from '../../access/core/second-factors.js';
import {
  BREAK_GLASS_PROBLEMS,
  SESSION_IDLE_MINUTES,
  SESSION_MAX_HOURS,
  SINGLE_SIGN_ON_RULES,
} from '../../access/core/sign-in-rules.js';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import { SELF_APPROVAL } from '../../change-sets/core/self-approval.js';
import type {
  InstallationSettings,
  ShownInstallationSettings,
} from '../core/installation-settings.js';

const SelfApproval = z
  .enum(SELF_APPROVAL)
  .describe(
    'Who may approve their own change set: `never` (the default: four eyes), `review` (its author may give the review approval; a restricted type’s sign-off still needs someone else) or `review-and-sign-off` (its author may give both). The author still needs the permission and scope as anyone would. Read when an approval is given: approvals given before a change stay.',
  );

const SecondFactor = z
  .enum(SECOND_FACTOR_RULES)
  .describe(
    'Who must sign in with a second factor (an authenticator app): `optional` (the default: each person’s own choice), `admins` (everyone holding `admin.roles`) or `everyone`. For people who sign in with a password or a code by email; single sign-on is the provider’s to secure. Someone without one sets it up at their next sign-in; sessions already running go on.',
  );

const SingleSignOn = z
  .enum(SINGLE_SIGN_ON_RULES)
  .describe(
    'Whether people must sign in with an identity provider: `optional` (the default) or `required`. Required, passwords, codes by email and their links are refused for everyone but the break-glass account’s password, and what was begun another way ends at once. Service accounts and their tokens are not affected.',
  );

const SessionIdleMinutes = z
  .number()
  .int()
  .min(SESSION_IDLE_MINUTES.min)
  .max(SESSION_IDLE_MINUTES.max)
  .nullable()
  .describe(
    'After how many minutes without a request of its person a session ends; null: the server’s own limit (`meta.serverSessionIdleMinutes`). Never longer than a session lasts.',
  );

const SessionMaxHours = z
  .number()
  .int()
  .min(SESSION_MAX_HOURS.min)
  .max(SESSION_MAX_HOURS.max)
  .nullable()
  .describe(
    'After how many hours a session ends, used or not; null: the server’s own limit (`meta.serverSessionMaxHours`).',
  );

const BreakGlassAccount = z
  .object({
    data: z
      .object({ type: z.literal('User'), id: UserId })
      .nullable()
      .describe('Null: nobody.'),
  })
  .describe(
    'Who may still sign in with their password while single sign-on is required: an active administrator, of their own and not through a group. Every use is audited (`user.break-glass-sign-in`) and the administrators are notified.',
  );

export const InstallationSettingsResource = resourceObject(
  'InstallationSettings',
  {
    attributes: z.object({
      selfApproval: SelfApproval,
      secondFactor: SecondFactor,
      singleSignOn: SingleSignOn,
      sessionIdleMinutes: SessionIdleMinutes,
      sessionMaxHours: SessionMaxHours,
      updatedAt: z.iso
        .datetime({ offset: true })
        .nullable()
        .describe('When they last changed; null: never.'),
    }),
    relationships: z.object({ breakGlassAccount: BreakGlassAccount }),
    meta: z.object({
      singleSignOnAvailable: z
        .boolean()
        .describe(
          'An identity provider is set up, so single sign-on can be required.',
        ),
      breakGlassProblem: z
        .enum(BREAK_GLASS_PROBLEMS)
        .nullable()
        .describe(
          'Why the break-glass account could not be signed in to now: `deactivated`, `no-admin-role` (none of their own), `no-password` or `password-sign-in-off`. Null when it could, or there is none.',
        ),
      serverSessionIdleMinutes: z
        .number()
        .describe('The server’s own limit (`CCMS_SESSION_IDLE_MINUTES`).'),
      serverSessionMaxHours: z
        .number()
        .describe('The server’s own limit (`CCMS_SESSION_MAX_HOURS`).'),
    }),
  },
)
  .describe(
    'The installation’s own settings, changed at once (not in a change set). `id` is always `installation`.',
  )
  .meta({ id: 'InstallationSettingsResource' });

export const InstallationSettingsDocument = singleDocument(
  InstallationSettingsResource,
).meta({ id: 'InstallationSettingsDocument' });
export type InstallationSettingsDocument = z.infer<
  typeof InstallationSettingsDocument
>;

export const UpdateInstallationSettingsDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('InstallationSettings'),
      id: z.literal('installation').optional(),
      attributes: z
        .strictObject({
          selfApproval: SelfApproval.optional(),
          secondFactor: SecondFactor.optional(),
          singleSignOn: SingleSignOn.optional(),
          sessionIdleMinutes: SessionIdleMinutes.optional(),
          sessionMaxHours: SessionMaxHours.optional(),
        })
        .optional()
        .describe('The settings to change; left out stays.'),
      relationships: z
        .strictObject({ breakGlassAccount: BreakGlassAccount.optional() })
        .optional(),
    }),
  })
  .meta({ id: 'UpdateInstallationSettingsDocument' });
export type UpdateInstallationSettingsDocument = z.output<
  typeof UpdateInstallationSettingsDocument
>;

export function toInstallationSettingsResource(
  stored: ShownInstallationSettings,
): z.infer<typeof InstallationSettingsResource> {
  return {
    type: 'InstallationSettings',
    id: 'installation',
    attributes: {
      selfApproval: stored.settings.selfApproval,
      secondFactor: stored.settings.secondFactor,
      singleSignOn: stored.settings.singleSignOn,
      sessionIdleMinutes: stored.settings.sessionIdleMinutes,
      sessionMaxHours: stored.settings.sessionMaxHours,
      updatedAt: stored.updatedAt?.toISOString() ?? null,
    },
    relationships: {
      breakGlassAccount: {
        data:
          stored.settings.breakGlassUserId === null
            ? null
            : { type: 'User', id: stored.settings.breakGlassUserId },
      },
    },
    meta: stored.signIn,
  };
}

/** The body's data as the action takes it: what is left out stays. */
export function toChanges({
  attributes = {},
  relationships,
}: UpdateInstallationSettingsDocument['data']): Partial<InstallationSettings> {
  const breakGlass = relationships?.breakGlassAccount;
  return {
    ...definedOf(attributes),
    ...(breakGlass && { breakGlassUserId: breakGlass.data?.id ?? null }),
  };
}

/** Without the members left out (an optional member may be `undefined` in the type). */
function definedOf<T extends object>(
  from: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(from).filter(([, value]) => value !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
