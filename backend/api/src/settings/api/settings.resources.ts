import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import { SELF_APPROVAL } from '../../change-sets/core/self-approval.js';
import type {
  InstallationSettings,
  StoredInstallationSettings,
} from '../core/installation-settings.js';

const SelfApproval = z
  .enum(SELF_APPROVAL)
  .describe(
    'Who may approve their own change set: `never` (the default: four eyes), `review` (its author may give the review approval; a restricted type’s sign-off still needs someone else) or `review-and-sign-off` (its author may give both). The author still needs the permission and scope as anyone would. Read when an approval is given: approvals given before a change stay.',
  );

export const InstallationSettingsResource = resourceObject(
  'InstallationSettings',
  {
    attributes: z.object({
      selfApproval: SelfApproval,
      updatedAt: z.iso
        .datetime({ offset: true })
        .nullable()
        .describe('When they last changed; null: never.'),
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
        .strictObject({ selfApproval: SelfApproval.optional() })
        .describe('The settings to change; left out stays.'),
    }),
  })
  .meta({ id: 'UpdateInstallationSettingsDocument' });
export type UpdateInstallationSettingsDocument = z.output<
  typeof UpdateInstallationSettingsDocument
>;

export function toInstallationSettingsResource(
  stored: StoredInstallationSettings,
): z.infer<typeof InstallationSettingsResource> {
  return {
    type: 'InstallationSettings',
    id: 'installation',
    attributes: {
      selfApproval: stored.settings.selfApproval,
      updatedAt: stored.updatedAt?.toISOString() ?? null,
    },
  };
}

/** The body's attributes as the action takes them. */
export function toChanges(
  body: UpdateInstallationSettingsDocument['data']['attributes'],
): Partial<InstallationSettings> {
  return body.selfApproval === undefined
    ? {}
    : { selfApproval: body.selfApproval };
}
