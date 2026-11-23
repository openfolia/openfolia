import { ConfigKey } from '@openfolia/content-model';
import { z } from 'zod';
import {
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import { RoleDescription, type StoredRole } from '../core/access-admin.js';
import type { Me } from '../core/actions/get-me.action.js';
import { RoleId, Scope, UserEmail, UserId, UserName } from '../core/actor.js';
import { Permission } from '../core/permissions.js';
import type { User } from '../core/user-directory.js';
import { UserSignInMeta } from './password.resources.js';
import { SessionMeta } from './sign-in.resources.js';

/** `Scope` (`core/actor.ts`) as sent: the input checks stay with the model. */
export const ScopeObject = z
  .object({
    languages: z.array(z.string()).optional(),
    moduleTypes: z.array(z.string()).optional(),
    maxAudience: z
      .string()
      .optional()
      .describe('The most restricted audience level covered.'),
    facets: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe('Per facet, the values covered.'),
  })
  .describe('Where permissions apply; a dimension left out means all of it.')
  .meta({ id: 'Scope' });

export const RoleObject = z
  .object({
    id: z.string(),
    name: z.string(),
    permissions: z.array(Permission),
    scope: ScopeObject,
  })
  .meta({ id: 'Role' });

export const ActorResource = resourceObject('Actor', {
  attributes: z.object({
    kind: z.enum(['user', 'service']),
    name: z.string().describe("The user's name, or the service's."),
    roles: z.array(RoleObject),
  }),
  meta: z.object({
    permissions: z
      .array(
        z.object({
          permission: Permission,
          scopes: z
            .array(ScopeObject)
            .describe('Where it is held, one per role; `[{}]`: everywhere.'),
        }),
      )
      .describe('Each permission held; permissions not held are left out.'),
    session: SessionMeta.optional(),
  }),
})
  .describe(
    '`id` is the user ID, the service account ID (`kind` `service`), or `service:api-token` for the shared token acting as a read-only service.',
  )
  .meta({ id: 'ActorResource' });

export const ActorDocument = singleDocument(ActorResource).meta({
  id: 'ActorDocument',
});

export function toActorResource(
  { actor, name, permissions }: Me,
  session?: { readonly provider: string; readonly expiresAt: Date },
): z.infer<typeof ActorResource> {
  return {
    type: 'Actor',
    id: actor.id,
    attributes: {
      kind: actor.kind,
      name,
      roles: actor.roles.map(({ id, name, permissions, scope }) => ({
        id,
        name,
        permissions: [...permissions],
        scope,
      })),
    },
    meta: {
      permissions: permissions.map(({ permission, scopes }) => ({
        permission,
        scopes: [...scopes],
      })),
      ...(session && {
        session: {
          provider: session.provider,
          expiresAt: session.expiresAt.toISOString(),
        },
      }),
    },
  };
}

export const UserResource = resourceObject('User', {
  attributes: z.object({
    name: z.string(),
    email: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Null when the user has none; left out by `GET /demo/users`, which any token holder may call.',
      ),
    deactivatedAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        'When it was deactivated (it cannot act then); null while active.',
      ),
  }),
  relationships: z.object({
    roles: z.object({
      data: z.array(z.object({ type: z.literal('Role'), id: z.string() })),
    }),
  }),
  meta: z.object({
    permissions: z
      .array(Permission)
      .describe(
        'Derived from its roles: every permission some role of the user holds, in any scope (for a client telling what a person may do, e.g. a contributor, who neither reviews nor approves). Actions still check the target.',
      ),
    groupRoleIds: z
      .array(z.string())
      .describe(
        'Of its roles (`relationships.roles`, every role it holds), those it holds only through its identity provider’s groups (#37): they follow the group mappings, and taking them from the user directly changes nothing.',
      ),
    signIn: UserSignInMeta.optional(),
  }),
}).meta({ id: 'UserResource' });

export const UserDocument = singleDocument(UserResource).meta({
  id: 'UserDocument',
});

export const UserPageDocument = pagedDocument(UserResource).meta({
  id: 'UserPageDocument',
});

/** The user as an admin reads it; `withEmail: false` for the demo switcher. */
export function toUserResource(
  user: User,
  { withEmail = true }: { withEmail?: boolean } = {},
): z.infer<typeof UserResource> {
  return {
    type: 'User',
    id: user.id,
    attributes: {
      name: user.name,
      ...(withEmail && { email: user.email }),
      deactivatedAt: user.deactivatedAt?.toISOString() ?? null,
    },
    relationships: {
      roles: { data: user.roleIds.map((id) => ({ type: 'Role', id })) },
    },
    meta: {
      permissions: [...user.permissions],
      groupRoleIds: [...user.groupRoleIds],
      ...(withEmail &&
        user.signIn && {
          signIn: {
            password: user.signIn.password,
            provider: user.signIn.provider,
            inviteExpiresAt: user.signIn.inviteExpiresAt?.toISOString() ?? null,
          },
        }),
    },
  };
}

export const RoleResource = resourceObject('Role', {
  attributes: z.object({
    name: z.string(),
    description: z.string().nullable(),
    permissions: z.array(Permission),
    scope: ScopeObject,
  }),
  meta: z.object({
    holders: z
      .number()
      .int()
      .describe(
        'How many users and service accounts hold it, deactivated ones included.',
      ),
  }),
}).meta({ id: 'RoleResource' });

export const RoleDocument = singleDocument(RoleResource).meta({
  id: 'RoleDocument',
});

export const RolePageDocument = pagedDocument(RoleResource).meta({
  id: 'RolePageDocument',
});

export function toRoleResource(role: StoredRole): z.infer<typeof RoleResource> {
  return {
    type: 'Role',
    id: role.id,
    attributes: {
      name: role.name,
      description: role.description,
      permissions: [...role.permissions],
      scope: role.scope,
    },
    meta: { holders: role.holders },
  };
}

/** A role's permissions as sent: each once, put in the order `PERMISSIONS` lists them. */
const Permissions = z
  .array(Permission)
  .min(1)
  .refine((items) => new Set(items).size === items.length, 'duplicate value')
  .transform((items) => [...items].sort((a, b) => order(a) - order(b)));
const order = (p: Permission) => Permission.options.indexOf(p);

/**
 * `Scope` as sent: the same checks (`Scope.safeParse`), on a schema the
 * OpenAPI document can show (`Scope` guards its facets with a custom check).
 */
const ScopeInput = z.preprocess(
  (scope, ctx) => {
    // A "__proto__" facet would be dropped by the record silently, widening the scope.
    const facets = (scope as { facets?: unknown } | null)?.facets;
    if (
      typeof facets === 'object' &&
      facets !== null &&
      Object.hasOwn(facets, '__proto__')
    ) {
      ctx.addIssue({
        code: 'custom',
        message: '"__proto__" is not a facet',
        path: ['facets'],
        input: scope,
      });
    }
    return scope;
  },
  z
    .strictObject({
      ...Scope.shape,
      facets: z
        .record(ConfigKey, z.array(ConfigKey))
        .optional()
        .describe('Per facet, the values covered; at least one facet.'),
    })
    .superRefine((scope, ctx) => {
      const checked = Scope.safeParse(scope);
      for (const issue of checked.error?.issues ?? []) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
      }
    }),
);

const RoleAttributes = z.strictObject({
  name: UserName.describe('1 to 200 characters.'),
  description: RoleDescription.nullable()
    .optional()
    .describe('What the role is for, 1 to 500 characters; null for none.'),
  permissions: Permissions.describe('At least one, each once.'),
  scope: ScopeInput.optional().describe(
    'Where the permissions apply; left out (or `{}`): everywhere. `admin.roles`, `admin.branding` and `webhook.manage` apply everywhere whatever it says.',
  ),
});

/** `POST /roles`. */
export const CreateRoleDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Role'),
      id: RoleId.describe(
        'The new role’s ID, chosen by the client: a lowercase key, e.g. `safety-approver`.',
      ),
      attributes: RoleAttributes,
    }),
  })
  .meta({ id: 'CreateRoleDocument' });
export type CreateRoleDocument = z.output<typeof CreateRoleDocument>;

/** `PATCH /roles/{roleId}`: the attributes to change. */
export const UpdateRoleDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Role'),
      id: z.string().describe('The role’s ID, as in the path.'),
      attributes: RoleAttributes.partial(),
    }),
  })
  .meta({ id: 'UpdateRoleDocument' });
export type UpdateRoleDocument = z.output<typeof UpdateRoleDocument>;

/** Role linkage: each role once. */
export const RoleLinkage = z
  .array(z.strictObject({ type: z.literal('Role'), id: RoleId }))
  .max(200)
  .refine(
    (items) => new Set(items.map((r) => r.id)).size === items.length,
    'duplicate role',
  );

const UserRoles = z
  .strictObject({ data: RoleLinkage })
  .describe('The roles the user holds (replacing those it held).');

/** `POST /users`. */
export const CreateUserDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('User'),
      id: UserId.describe(
        'The new user’s ID, chosen by the client: lowercase letters, digits, ".", "_" and "-".',
      ),
      attributes: z.strictObject({
        name: UserName.describe('1 to 200 characters.'),
        email: UserEmail.describe(
          'Unique ignoring case; at most 254 characters.',
        ),
      }),
      relationships: z.strictObject({ roles: UserRoles }).optional(),
    }),
  })
  .meta({ id: 'CreateUserDocument' });
export type CreateUserDocument = z.output<typeof CreateUserDocument>;

/** `PATCH /users/{userId}`: the attributes and roles to change. */
export const UpdateUserDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('User'),
      id: z.string().describe('The user’s ID, as in the path.'),
      attributes: z
        .strictObject({
          name: UserName.optional(),
          email: UserEmail.nullable().optional().describe('Null removes it.'),
        })
        .optional(),
      relationships: z.strictObject({ roles: UserRoles }).optional(),
    }),
  })
  .meta({ id: 'UpdateUserDocument' });
export type UpdateUserDocument = z.output<typeof UpdateUserDocument>;

/** `POST` and `DELETE /users/{userId}/relationships/roles`: the roles to add or remove. */
export const RoleRelationshipDocument = z
  .strictObject({ data: RoleLinkage.min(1) })
  .meta({ id: 'RoleRelationshipDocument' });
export type RoleRelationshipDocument = z.output<
  typeof RoleRelationshipDocument
>;

/** A user's roles, as the relationship routes answer. */
export const UserRolesDocument = z
  .object({
    data: z.array(z.object({ type: z.literal('Role'), id: z.string() })),
  })
  .meta({ id: 'UserRolesDocument' });

/** `POST /users/{userId}/deactivate`: the user, and how many locks it lost. */
export const DeactivatedUserDocument = z
  .object({
    data: UserResource,
    meta: z.object({
      locksReleased: z
        .number()
        .int()
        .describe('Locks it held, released with it.'),
    }),
  })
  .meta({ id: 'DeactivatedUserDocument' });

/** Filter parameters of `GET /users`, validated before any query. */
export const userFilters = {
  role: RoleId,
  status: z.enum(['active', 'deactivated']),
  q: z.string().trim().min(1).max(200),
};
