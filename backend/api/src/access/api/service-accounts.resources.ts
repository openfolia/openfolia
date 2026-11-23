import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import { RoleId } from '../core/actor.js';
import {
  type ServiceAccount,
  ServiceAccountDescription,
  ServiceAccountId,
  ServiceAccountName,
  type ServiceToken,
  ServiceTokenName,
} from '../core/service-accounts.js';
import { RoleLinkage } from './access.resources.js';

const RoleLinks = z.object({
  data: z.array(z.object({ type: z.literal('Role'), id: z.string() })),
});

export const ServiceAccountResource = resourceObject('ServiceAccount', {
  attributes: z.object({
    name: z.string(),
    description: z.string().nullable(),
    deactivatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        'When it was deactivated (none of its tokens may act then); null while active.',
      ),
    createdAt: z.iso.datetime({ offset: true }),
  }),
  relationships: z.object({ roles: RoleLinks }),
})
  .describe(
    'A machine client (a portal build, a pipeline, an agent) acting with its own roles through its own tokens. As an actor its kind is `service`.',
  )
  .meta({ id: 'ServiceAccountResource' });

export const ServiceAccountDocument = singleDocument(
  ServiceAccountResource,
).meta({ id: 'ServiceAccountDocument' });

export const ServiceAccountPageDocument = pagedDocument(
  ServiceAccountResource,
).meta({ id: 'ServiceAccountPageDocument' });

export function toServiceAccountResource(
  account: ServiceAccount,
): z.infer<typeof ServiceAccountResource> {
  return {
    type: 'ServiceAccount',
    id: account.id,
    attributes: {
      name: account.name,
      description: account.description,
      deactivatedAt: account.deactivatedAt?.toISOString() ?? null,
      createdAt: account.createdAt.toISOString(),
    },
    relationships: {
      roles: {
        data: account.roleIds.map((id) => ({ type: 'Role' as const, id })),
      },
    },
  };
}

/** `POST /service-accounts/{id}/deactivate`: the account, and how many locks it lost. */
export const DeactivatedServiceAccountDocument = z
  .object({
    data: ServiceAccountResource,
    meta: z.object({
      locksReleased: z
        .number()
        .int()
        .describe('Locks it held, released with it.'),
    }),
  })
  .meta({ id: 'DeactivatedServiceAccountDocument' });

export const ServiceTokenResource = resourceObject('ServiceToken', {
  attributes: z.object({
    name: z.string().describe('What the token is for.'),
    createdAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    lastUsedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When it last authenticated, to the minute; null: never.'),
    revokedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe('When it was revoked; null while not.'),
  }),
  relationships: z.object({
    serviceAccount: z.object({
      data: z.object({ type: z.literal('ServiceAccount'), id: z.string() }),
    }),
  }),
})
  .describe(
    'A token of a service account, as listed: never the token itself, which is shown only once, when issued. `id` is the token’s public part (`ccms_sat_<id>_…`).',
  )
  .meta({ id: 'ServiceTokenResource' });

export const ServiceTokenDocument = singleDocument(ServiceTokenResource).meta({
  id: 'ServiceTokenDocument',
});

export const ServiceTokenPageDocument = pagedDocument(
  ServiceTokenResource,
).meta({ id: 'ServiceTokenPageDocument' });

/** `POST /service-accounts/{id}/tokens`: the token as listed, and the token itself, this once. */
export const IssuedServiceTokenDocument = z
  .object({
    data: ServiceTokenResource,
    meta: z.object({
      token: z
        .string()
        .describe(
          'The bearer token (`ccms_sat_<id>_<secret>`). Shown only in this answer: store it now; it cannot be read again.',
        ),
    }),
  })
  .meta({ id: 'IssuedServiceTokenDocument' });

export function toServiceTokenResource(
  token: ServiceToken,
): z.infer<typeof ServiceTokenResource> {
  return {
    type: 'ServiceToken',
    id: token.id,
    attributes: {
      name: token.name,
      createdAt: token.createdAt.toISOString(),
      expiresAt: token.expiresAt.toISOString(),
      lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
      revokedAt: token.revokedAt?.toISOString() ?? null,
    },
    relationships: {
      serviceAccount: {
        data: { type: 'ServiceAccount', id: token.serviceAccountId },
      },
    },
  };
}

const ServiceAccountRoles = z
  .strictObject({ data: RoleLinkage })
  .describe('The roles it holds (replacing those it held).');

/** `POST /service-accounts`. */
export const CreateServiceAccountDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('ServiceAccount'),
      id: ServiceAccountId.describe(
        'The new service account’s ID, chosen by the client: lowercase letters, digits, ".", "_" and "-".',
      ),
      attributes: z.strictObject({
        name: ServiceAccountName.describe('1 to 200 characters.'),
        description: ServiceAccountDescription.nullable()
          .optional()
          .describe('What it is for, 1 to 500 characters; null for none.'),
      }),
      relationships: z.strictObject({ roles: ServiceAccountRoles }).optional(),
    }),
  })
  .meta({ id: 'CreateServiceAccountDocument' });
export type CreateServiceAccountDocument = z.output<
  typeof CreateServiceAccountDocument
>;

/** `PATCH /service-accounts/{id}`. */
export const UpdateServiceAccountDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('ServiceAccount'),
      id: z.string().describe('The service account’s ID, as in the path.'),
      attributes: z
        .strictObject({
          name: ServiceAccountName.optional(),
          description: ServiceAccountDescription.nullable()
            .optional()
            .describe('Null removes it.'),
        })
        .optional(),
      relationships: z.strictObject({ roles: ServiceAccountRoles }).optional(),
    }),
  })
  .meta({ id: 'UpdateServiceAccountDocument' });
export type UpdateServiceAccountDocument = z.output<
  typeof UpdateServiceAccountDocument
>;

/** `POST /service-accounts/{id}/tokens`. */
export const IssueServiceTokenDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('ServiceToken'),
      attributes: z.strictObject({
        name: ServiceTokenName.describe(
          'What it is for, 1 to 100 characters, e.g. "portal build, production".',
        ),
        expiresAt: z.iso
          .datetime({ offset: true })
          .optional()
          .describe(
            'When it stops working: in the future, within 366 days. Default: 90 days from now.',
          ),
      }),
    }),
  })
  .meta({ id: 'IssueServiceTokenDocument' });
export type IssueServiceTokenDocument = z.output<
  typeof IssueServiceTokenDocument
>;

/** Filter parameters of `GET /service-accounts`, validated before any query. */
export const serviceAccountFilters = {
  role: RoleId,
  status: z.enum(['active', 'deactivated']),
  q: z.string().trim().min(1).max(200),
};
