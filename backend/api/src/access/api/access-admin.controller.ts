import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { CreateRoleAction } from '../core/actions/create-role.action.js';
import { CreateUserAction } from '../core/actions/create-user.action.js';
import {
  DeactivateUserAction,
  ReactivateUserAction,
} from '../core/actions/deactivate-user.action.js';
import { DeleteRoleAction } from '../core/actions/delete-role.action.js';
import { GetUserAction } from '../core/actions/get-user.action.js';
import {
  GetRoleAction,
  ListRolesAction,
} from '../core/actions/list-roles.action.js';
import { UpdateRoleAction } from '../core/actions/update-role.action.js';
import { UpdateUserAction } from '../core/actions/update-user.action.js';
import type { Actor } from '../core/actor.js';
import { authorize } from '../core/policy.js';
import {
  CreateRoleDocument,
  CreateUserDocument,
  DeactivatedUserDocument,
  RoleDocument,
  RolePageDocument,
  RoleRelationshipDocument,
  toRoleResource,
  toUserResource,
  UpdateRoleDocument,
  UpdateUserDocument,
  UserDocument,
  UserRolesDocument,
} from './access.resources.js';
import { ApiPermission } from './api-permission.decorator.js';

const ROLE_ID = {
  name: 'roleId',
  description:
    'The role’s ID (a lowercase key). One that names no role is 404.',
  schema: { type: 'string' },
} as const;

const USER_ID = {
  name: 'userId',
  description: 'The user’s ID. One that names no user is 404.',
  schema: { type: 'string' },
} as const;

const ROLE_NOT_FOUND = {
  description: '`not-found`: no role with this ID.',
  standardSchema: ErrorDocument,
};

const USER_NOT_FOUND = {
  description: '`not-found`: no user with this ID.',
  standardSchema: ErrorDocument,
};

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long (`CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS`, `CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS`); nothing of it was written to the database. `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
};

const LAST_ADMIN =
  '`last-admin`: it would leave no active user holding `admin.roles`.';

const UNKNOWN_ROLE = {
  description: '`unknown-role`: a role to give does not exist (`meta.roles`).',
  standardSchema: ErrorDocument,
};

const APPLIES =
  'Changes apply at once (from the next request of whoever they concern) and are recorded in the audit log. Needs `admin.roles`.';

/**
 * 409 `id-mismatch` when a body's `data.id` is not the path's; checked
 * after the permission, so an actor without it learns nothing either way.
 */
function sameId(actor: Actor, path: string, body: string): void {
  authorize(actor, 'admin.roles');
  if (path !== body) {
    throw new JsonApiException(HttpStatus.CONFLICT, [
      {
        code: 'id-mismatch',
        detail: '`data.id` must be the ID in the path.',
        source: { pointer: '/data/id' },
      },
    ]);
  }
}

type RoleDoc = z.infer<typeof RoleDocument>;
type UserDoc = z.infer<typeof UserDocument>;
type UserRolesDoc = z.infer<typeof UserRolesDocument>;

/**
 * Administering access (`admin.roles`): roles, users and who holds which
 * role, and deactivating users. `GET /users` is in `AccessController`.
 */
@ApiTags('access')
@Controller()
@JsonApi()
export class AccessAdminController {
  constructor(
    private readonly listRoles: ListRolesAction,
    private readonly getRole: GetRoleAction,
    private readonly createRole: CreateRoleAction,
    private readonly updateRole: UpdateRoleAction,
    private readonly deleteRole: DeleteRoleAction,
    private readonly getUser: GetUserAction,
    private readonly createUser: CreateUserAction,
    private readonly updateUser: UpdateUserAction,
    private readonly deactivateUser: DeactivateUserAction,
    private readonly reactivateUser: ReactivateUserAction,
  ) {}

  @Get('roles')
  @Header('Cache-Control', 'no-store')
  @Paged()
  @ApiOperation({
    summary: 'Roles',
    description:
      'Roles by name: their permissions and scope, and in `meta.holders` how many users and service accounts hold each. Needs `admin.roles`.',
  })
  @ApiOkResponse({ standardSchema: RolePageDocument })
  @ApiPermission('admin.roles')
  async roles(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof RolePageDocument>> {
    const result = await this.listRoles.handle({ actor, page });
    return toPagedDocument(req, page, result, toRoleResource);
  }

  @Get('roles/:roleId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'A role', description: 'Needs `admin.roles`.' })
  @ApiParam(ROLE_ID)
  @ApiOkResponse({ standardSchema: RoleDocument })
  @ApiNotFoundResponse(ROLE_NOT_FOUND)
  @ApiPermission('admin.roles')
  async role(
    @CurrentActor() actor: Actor,
    @Param('roleId') roleId: string,
  ): Promise<RoleDoc> {
    return {
      data: toRoleResource(await this.getRole.handle({ actor, roleId })),
    };
  }

  @Post('roles')
  @ApiOperation({
    summary: 'Create a role',
    description: `A role (name, description, permissions, scope) under an ID the client chooses, held by nobody yet. Recorded as \`role.create\`. ${APPLIES}`,
  })
  @ApiCreatedResponse({
    standardSchema: RoleDocument,
    headers: {
      Location: { description: 'The new role.', schema: { type: 'string' } },
    },
  })
  @ApiConflictResponse({
    description: '`role-exists`: the ID is taken.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async create(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateRoleDocument }) body: CreateRoleDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RoleDoc> {
    const { id, attributes } = body.data;
    const role = await this.createRole.handle({
      actor,
      role: {
        id,
        name: attributes.name,
        description: attributes.description ?? null,
        permissions: attributes.permissions,
        scope: attributes.scope ?? {},
      },
    });
    res.setHeader('Location', `/roles/${role.id}`);
    return { data: toRoleResource(role) };
  }

  @Patch('roles/:roleId')
  @ApiOperation({
    summary: 'Change a role',
    description: `Its name, description, permissions or scope (replaced whole); attributes left out stay. Recorded as \`role.update\`. ${APPLIES}`,
  })
  @ApiParam(ROLE_ID)
  @ApiOkResponse({ standardSchema: RoleDocument })
  @ApiNotFoundResponse(ROLE_NOT_FOUND)
  @ApiConflictResponse({
    description: `${LAST_ADMIN} \`role-held-by-service-account\`: it would give \`admin.roles\` to a role service accounts hold. \`id-mismatch\`: \`data.id\` is not the path’s.`,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async update(
    @CurrentActor() actor: Actor,
    @Param('roleId') roleId: string,
    @Body({ schema: UpdateRoleDocument }) body: UpdateRoleDocument,
  ): Promise<RoleDoc> {
    sameId(actor, roleId, body.data.id);
    const { attributes } = body.data;
    const role = await this.updateRole.handle({
      actor,
      roleId,
      changes: {
        ...(attributes.name !== undefined && { name: attributes.name }),
        ...(attributes.description !== undefined && {
          description: attributes.description,
        }),
        ...(attributes.permissions !== undefined && {
          permissions: attributes.permissions,
        }),
        ...(attributes.scope !== undefined && { scope: attributes.scope }),
      },
    });
    return { data: toRoleResource(role) };
  }

  @Delete('roles/:roleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a role',
    description: `Only a role nobody holds. Recorded as \`role.delete\`. ${APPLIES}`,
  })
  @ApiParam(ROLE_ID)
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse(ROLE_NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`role-in-use`: users or service accounts hold it (`meta.holders`), or a group mapping gives it (`meta.groupMappings`).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async delete(
    @CurrentActor() actor: Actor,
    @Param('roleId') roleId: string,
  ): Promise<void> {
    await this.deleteRole.handle({ actor, roleId });
  }

  @Get('users/:userId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A user',
    description: 'Deactivated or not. Needs `admin.roles`.',
  })
  @ApiParam(USER_ID)
  @ApiOkResponse({ standardSchema: UserDocument })
  @ApiNotFoundResponse(USER_NOT_FOUND)
  @ApiPermission('admin.roles')
  async user(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<UserDoc> {
    return {
      data: toUserResource(await this.getUser.handle({ actor, userId })),
    };
  }

  @Post('users')
  @ApiOperation({
    summary: 'Add a user',
    description: `A person added by hand, until sign-in creates them: an ID the client chooses, a name, an email address and roles; active at once. Recorded as \`user.create\` (IDs only) and \`role.assign\` per role. ${APPLIES}`,
  })
  @ApiCreatedResponse({
    standardSchema: UserDocument,
    headers: {
      Location: { description: 'The new user.', schema: { type: 'string' } },
    },
  })
  @ApiConflictResponse({
    description:
      '`user-exists`: the ID is taken. `email-taken`: another user has this email address.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse(UNKNOWN_ROLE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async createUserRoute(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateUserDocument }) body: CreateUserDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UserDoc> {
    const { id, attributes, relationships } = body.data;
    const user = await this.createUser.handle({
      actor,
      user: { id, name: attributes.name, email: attributes.email },
      roleIds: (relationships?.roles.data ?? []).map((r) => r.id),
    });
    res.setHeader('Location', `/users/${user.id}`);
    return { data: toUserResource(user) };
  }

  @Patch('users/:userId')
  @ApiOperation({
    summary: 'Change a user',
    description: `Its name or email address, and its roles (\`relationships.roles\` replaces them), in one change; what is left out stays. A new address ends the link to set a password and the open code by email sent to the old one. Recorded as \`user.update\` (the fields changed, never their values) and \`role.assign\` or \`role.unassign\` per role. ${APPLIES}`,
  })
  @ApiParam(USER_ID)
  @ApiOkResponse({ standardSchema: UserDocument })
  @ApiNotFoundResponse(USER_NOT_FOUND)
  @ApiConflictResponse({
    description: `\`email-taken\`: another user has this email address. ${LAST_ADMIN} \`id-mismatch\`: \`data.id\` is not the path’s.`,
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse(UNKNOWN_ROLE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async updateUserRoute(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
    @Body({ schema: UpdateUserDocument }) body: UpdateUserDocument,
  ): Promise<UserDoc> {
    sameId(actor, userId, body.data.id);
    const { attributes, relationships } = body.data;
    const user = await this.updateUser.handle({
      actor,
      userId,
      changes: {
        ...(attributes?.name !== undefined && { name: attributes.name }),
        ...(attributes?.email !== undefined && { email: attributes.email }),
        ...(relationships && {
          roles: { set: relationships.roles.data.map((r) => r.id) },
        }),
      },
    });
    return { data: toUserResource(user) };
  }

  @Post('users/:userId/relationships/roles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Give a user roles',
    description: `Adds the roles listed; one it holds already stays. Answers the roles it holds now. Recorded as \`role.assign\` per role added. ${APPLIES}`,
  })
  @ApiParam(USER_ID)
  @ApiOkResponse({ standardSchema: UserRolesDocument })
  @ApiNotFoundResponse(USER_NOT_FOUND)
  @ApiUnprocessableEntityResponse(UNKNOWN_ROLE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async addRoles(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
    @Body({ schema: RoleRelationshipDocument }) body: RoleRelationshipDocument,
  ): Promise<UserRolesDoc> {
    const user = await this.updateUser.handle({
      actor,
      userId,
      changes: { roles: { add: body.data.map((r) => r.id) } },
    });
    return toRoleLinkage(user.roleIds);
  }

  @Delete('users/:userId/relationships/roles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take roles from a user',
    description: `Removes the roles listed; one it does not hold is ignored. Answers the roles it holds now. Recorded as \`role.unassign\` per role removed. ${APPLIES}`,
  })
  @ApiParam(USER_ID)
  @ApiOkResponse({ standardSchema: UserRolesDocument })
  @ApiNotFoundResponse(USER_NOT_FOUND)
  @ApiConflictResponse({
    description: LAST_ADMIN,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async removeRoles(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
    @Body({ schema: RoleRelationshipDocument }) body: RoleRelationshipDocument,
  ): Promise<UserRolesDoc> {
    const user = await this.updateUser.handle({
      actor,
      userId,
      changes: { roles: { remove: body.data.map((r) => r.id) } },
    });
    return toRoleLinkage(user.roleIds);
  }

  @Post('users/:userId/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a user',
    description: `From its next request on, the user cannot act (403 \`user-deactivated\`), and approvals it gave no longer hold. Every lock it holds is released (\`meta.locksReleased\`, each a \`lock.release\` audit event). Its sessions, its link to set a password and its open code by email end. Its roles stay, for a reactivation. Recorded as \`user.deactivate\`. ${APPLIES}`,
  })
  @ApiParam(USER_ID)
  @ApiOkResponse({ standardSchema: DeactivatedUserDocument })
  @ApiNotFoundResponse(USER_NOT_FOUND)
  @ApiConflictResponse({
    description: `\`already-deactivated\`: it is. ${LAST_ADMIN}`,
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async deactivate(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<z.infer<typeof DeactivatedUserDocument>> {
    const { user, locksReleased } = await this.deactivateUser.handle({
      actor,
      userId,
    });
    return { data: toUserResource(user), meta: { locksReleased } };
  }

  @Post('users/:userId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate a user',
    description: `The user may act again, with the roles it had. Recorded as \`user.reactivate\`. ${APPLIES}`,
  })
  @ApiParam(USER_ID)
  @ApiOkResponse({ standardSchema: UserDocument })
  @ApiNotFoundResponse(USER_NOT_FOUND)
  @ApiConflictResponse({
    description: '`not-deactivated`: it is active.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async reactivate(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<UserDoc> {
    return {
      data: toUserResource(await this.reactivateUser.handle({ actor, userId })),
    };
  }
}

function toRoleLinkage(roleIds: readonly string[]): UserRolesDoc {
  return { data: roleIds.map((id) => ({ type: 'Role' as const, id })) };
}
