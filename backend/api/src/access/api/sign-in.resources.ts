import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import { RoleId } from '../core/actor.js';
import { type GroupMapping, GroupName } from '../core/group-mappings.js';
import type { OfferedProvider } from '../core/actions/sign-in.action.js';

export const IdentityProviderResource = resourceObject('IdentityProvider', {
  attributes: z.object({
    name: z
      .string()
      .nullable()
      .describe(
        'What the sign-in button names (`CCMS_OIDC_NAME`); null: the client’s own wording.',
      ),
  }),
  links: z.object({
    signIn: z
      .string()
      .describe(
        'Where to send the browser to sign in, relative to the API; add `?returnTo=<path inside the editor>`.',
      ),
  }),
})
  .describe('`id` is the provider’s key, e.g. `oidc`.')
  .meta({ id: 'IdentityProviderResource' });

export const IdentityProviderPageDocument = pagedDocument(
  IdentityProviderResource,
).meta({ id: 'IdentityProviderPageDocument' });

export function toIdentityProviderResource(
  provider: OfferedProvider,
): z.infer<typeof IdentityProviderResource> {
  return {
    type: 'IdentityProvider',
    id: provider.id,
    attributes: { name: provider.displayName },
    links: { signIn: `auth/${provider.id}/sign-in` },
  };
}

/** `POST /auth/sign-out`'s answer. */
export const SignedOutDocument = z
  .object({
    meta: z.object({
      signOutUrl: z
        .string()
        .nullable()
        .describe(
          "The identity provider's sign-out address, to send the browser to so the person is signed out there too; null when there is none.",
        ),
    }),
  })
  .meta({ id: 'SignedOutDocument' });

/** `meta.session` of `GET /me`, for a request acting through a person's session. */
export const SessionMeta = z
  .object({
    provider: z.string().describe('The identity provider it began with.'),
    expiresAt: z.iso
      .datetime({ offset: true })
      .describe('When it ends unless used again (or at its longest lifetime).'),
  })
  .describe(
    'Present when the request acts through a signed-in session (#37): the client offers signing out.',
  )
  .meta({ id: 'SessionMeta' });

export const GroupMappingResource = resourceObject('GroupMapping', {
  attributes: z.object({
    group: z
      .string()
      .describe('The group’s name, as the identity provider sends it.'),
    createdAt: z.iso.datetime({ offset: true }),
  }),
  relationships: z.object({
    role: z.object({
      data: z.object({ type: z.literal('Role'), id: z.string() }),
    }),
  }),
}).meta({ id: 'GroupMappingResource' });

export const GroupMappingDocument = singleDocument(GroupMappingResource).meta({
  id: 'GroupMappingDocument',
});

export const GroupMappingPageDocument = pagedDocument(
  GroupMappingResource,
).meta({ id: 'GroupMappingPageDocument' });

export function toGroupMappingResource(
  mapping: GroupMapping,
): z.infer<typeof GroupMappingResource> {
  return {
    type: 'GroupMapping',
    id: mapping.id,
    attributes: {
      group: mapping.group,
      createdAt: mapping.createdAt.toISOString(),
    },
    relationships: { role: { data: { type: 'Role', id: mapping.roleId } } },
  };
}

/** `POST /group-mappings`. */
export const CreateGroupMappingDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('GroupMapping'),
      attributes: z.strictObject({
        group: GroupName.describe(
          'The group’s name exactly as the identity provider sends it (case counts), 1 to 256 characters.',
        ),
      }),
      relationships: z.strictObject({
        role: z.strictObject({
          data: z.strictObject({ type: z.literal('Role'), id: RoleId }),
        }),
      }),
    }),
  })
  .meta({ id: 'CreateGroupMappingDocument' });
export type CreateGroupMappingDocument = z.output<
  typeof CreateGroupMappingDocument
>;

/** Filter parameters of `GET /group-mappings`. */
export const groupMappingFilters = {
  group: GroupName,
  role: RoleId,
};
