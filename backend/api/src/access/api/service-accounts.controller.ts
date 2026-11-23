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
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
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
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import { CreateServiceAccountAction } from '../core/actions/create-service-account.action.js';
import {
  DeactivateServiceAccountAction,
  ReactivateServiceAccountAction,
} from '../core/actions/deactivate-service-account.action.js';
import {
  GetServiceAccountAction,
  ListServiceAccountsAction,
} from '../core/actions/list-service-accounts.action.js';
import {
  IssueServiceTokenAction,
  ListServiceTokensAction,
  RevokeServiceTokenAction,
} from '../core/actions/service-tokens.action.js';
import { UpdateServiceAccountAction } from '../core/actions/update-service-account.action.js';
import type { Actor } from '../core/actor.js';
import { authorize } from '../core/policy.js';
import {
  RoleRelationshipDocument,
  UserRolesDocument,
} from './access.resources.js';
import { ApiPermission } from './api-permission.decorator.js';
import {
  CreateServiceAccountDocument,
  DeactivatedServiceAccountDocument,
  IssuedServiceTokenDocument,
  IssueServiceTokenDocument,
  serviceAccountFilters,
  ServiceAccountDocument,
  ServiceAccountPageDocument,
  ServiceTokenDocument,
  ServiceTokenPageDocument,
  toServiceAccountResource,
  toServiceTokenResource,
  UpdateServiceAccountDocument,
} from './service-accounts.resources.js';

const ACCOUNT_ID = {
  name: 'serviceAccountId',
  description:
    'The service account’s ID. One that names no service account is 404.',
  schema: { type: 'string' },
} as const;

const TOKEN_ID = {
  name: 'tokenId',
  description:
    'The token’s ID (16 hex digits, its public part). One the service account has no token of is 404.',
  schema: { type: 'string' },
} as const;

const NOT_FOUND = {
  description: '`not-found`: no service account with this ID.',
  standardSchema: ErrorDocument,
};

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long; nothing of it was written. `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
};

const UNKNOWN_ROLE = {
  description:
    '`unknown-role`: a role to give does not exist (`meta.roles`). `admin-role-for-service-account`: a role to give holds `admin.roles`, which no service account may hold (`meta.roles`).',
  standardSchema: ErrorDocument,
};

const APPLIES =
  'Changes apply at once (from the next request of the service account) and are recorded in the audit log. Needs `admin.roles`, held by a user: a service account cannot change access, whatever its roles.';

type AccountDoc = z.infer<typeof ServiceAccountDocument>;
type RolesDoc = z.infer<typeof UserRolesDocument>;

/**
 * Service accounts and their tokens (#38): machine clients acting with
 * roles of their own. Administered like users (`admin.roles`).
 */
@ApiTags('access')
@Controller('service-accounts')
@JsonApi()
export class ServiceAccountsController {
  constructor(
    private readonly listAccounts: ListServiceAccountsAction,
    private readonly getAccount: GetServiceAccountAction,
    private readonly createAccount: CreateServiceAccountAction,
    private readonly updateAccount: UpdateServiceAccountAction,
    private readonly deactivateAccount: DeactivateServiceAccountAction,
    private readonly reactivateAccount: ReactivateServiceAccountAction,
    private readonly listTokens: ListServiceTokensAction,
    private readonly issueToken: IssueServiceTokenAction,
    private readonly revokeToken: RevokeServiceTokenAction,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Paged()
  @Filters(
    { name: 'role', description: 'Only holders of this role (its ID).' },
    {
      name: 'status',
      description: '`active` or `deactivated`; left out: both.',
    },
    {
      name: 'q',
      description:
        'Only service accounts whose ID or name contains this text, ignoring case.',
    },
  )
  @ApiOperation({
    summary: 'Service accounts',
    description:
      'Service accounts by ID, deactivated ones included, with their roles. Needs `admin.roles`.',
  })
  @ApiOkResponse({ standardSchema: ServiceAccountPageDocument })
  @ApiPermission('admin.roles')
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[role]', { schema: serviceAccountFilters.role.optional() })
    role?: string,
    @Query('filter[status]', {
      schema: serviceAccountFilters.status.optional(),
    })
    status?: 'active' | 'deactivated',
    @Query('filter[q]', { schema: serviceAccountFilters.q.optional() })
    q?: string,
  ): Promise<z.infer<typeof ServiceAccountPageDocument>> {
    const result = await this.listAccounts.handle({
      actor,
      page,
      filter: {
        ...(role !== undefined && { role }),
        ...(status !== undefined && { active: status === 'active' }),
        ...(q !== undefined && { q }),
      },
    });
    return toPagedDocument(req, page, result, toServiceAccountResource);
  }

  @Get(':serviceAccountId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A service account',
    description: 'Deactivated or not. Needs `admin.roles`.',
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ standardSchema: ServiceAccountDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('admin.roles')
  async one(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
  ): Promise<AccountDoc> {
    return {
      data: toServiceAccountResource(
        await this.getAccount.handle({ actor, serviceAccountId }),
      ),
    };
  }

  @Post()
  @ApiOperation({
    summary: 'Add a service account',
    description: `An ID the client chooses, a name, a description and roles; active at once, without tokens (issue one with \`POST /service-accounts/{id}/tokens\`). Recorded as \`service-account.create\` (IDs only) and \`role.assign\` per role. ${APPLIES}`,
  })
  @ApiCreatedResponse({
    standardSchema: ServiceAccountDocument,
    headers: {
      Location: {
        description: 'The new service account.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiConflictResponse({
    description: '`service-account-exists`: the ID is taken.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse(UNKNOWN_ROLE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async create(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateServiceAccountDocument })
    body: CreateServiceAccountDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AccountDoc> {
    const { id, attributes, relationships } = body.data;
    const account = await this.createAccount.handle({
      actor,
      account: {
        id,
        name: attributes.name,
        description: attributes.description ?? null,
      },
      roleIds: (relationships?.roles.data ?? []).map((r) => r.id),
    });
    res.setHeader('Location', `/service-accounts/${account.id}`);
    return { data: toServiceAccountResource(account) };
  }

  @Patch(':serviceAccountId')
  @ApiOperation({
    summary: 'Change a service account',
    description: `Its name or description, and its roles (\`relationships.roles\` replaces them), in one change; what is left out stays. Recorded as \`service-account.update\` (the fields changed, never their values) and \`role.assign\` or \`role.unassign\` per role. ${APPLIES}`,
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ standardSchema: ServiceAccountDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: '`id-mismatch`: `data.id` is not the path’s.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse(UNKNOWN_ROLE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async update(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
    @Body({ schema: UpdateServiceAccountDocument })
    body: UpdateServiceAccountDocument,
  ): Promise<AccountDoc> {
    sameId(actor, serviceAccountId, body.data.id);
    const { attributes, relationships } = body.data;
    const account = await this.updateAccount.handle({
      actor,
      serviceAccountId,
      changes: {
        ...(attributes?.name !== undefined && { name: attributes.name }),
        ...(attributes?.description !== undefined && {
          description: attributes.description,
        }),
        ...(relationships && {
          roles: { set: relationships.roles.data.map((r) => r.id) },
        }),
      },
    });
    return { data: toServiceAccountResource(account) };
  }

  @Post(':serviceAccountId/relationships/roles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Give a service account roles',
    description: `Adds the roles listed; one it holds already stays. Answers the roles it holds now. Recorded as \`role.assign\` per role added. ${APPLIES}`,
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ standardSchema: UserRolesDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiUnprocessableEntityResponse(UNKNOWN_ROLE)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async addRoles(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
    @Body({ schema: RoleRelationshipDocument }) body: RoleRelationshipDocument,
  ): Promise<RolesDoc> {
    const account = await this.updateAccount.handle({
      actor,
      serviceAccountId,
      changes: { roles: { add: body.data.map((r) => r.id) } },
    });
    return toRoleLinkage(account.roleIds);
  }

  @Delete(':serviceAccountId/relationships/roles')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take roles from a service account',
    description: `Removes the roles listed; one it does not hold is ignored. Answers the roles it holds now. Recorded as \`role.unassign\` per role removed. ${APPLIES}`,
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ standardSchema: UserRolesDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async removeRoles(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
    @Body({ schema: RoleRelationshipDocument }) body: RoleRelationshipDocument,
  ): Promise<RolesDoc> {
    const account = await this.updateAccount.handle({
      actor,
      serviceAccountId,
      changes: { roles: { remove: body.data.map((r) => r.id) } },
    });
    return toRoleLinkage(account.roleIds);
  }

  @Post(':serviceAccountId/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a service account',
    description: `From its next request on, none of its tokens may act (403 \`service-account-deactivated\`). Every lock it holds is released (\`meta.locksReleased\`, each a \`lock.release\` audit event). Its roles and tokens stay, for a reactivation. Recorded as \`service-account.deactivate\`. ${APPLIES}`,
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ standardSchema: DeactivatedServiceAccountDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: '`already-deactivated`: it is.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async deactivate(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
  ): Promise<z.infer<typeof DeactivatedServiceAccountDocument>> {
    const { account, locksReleased } = await this.deactivateAccount.handle({
      actor,
      serviceAccountId,
    });
    return { data: toServiceAccountResource(account), meta: { locksReleased } };
  }

  @Post(':serviceAccountId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate a service account',
    description: `Its tokens (those neither revoked nor expired) may act again, with the roles it had. Recorded as \`service-account.reactivate\`. ${APPLIES}`,
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ standardSchema: ServiceAccountDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: '`not-deactivated`: it is active.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async reactivate(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
  ): Promise<AccountDoc> {
    return {
      data: toServiceAccountResource(
        await this.reactivateAccount.handle({ actor, serviceAccountId }),
      ),
    };
  }

  @Get(':serviceAccountId/tokens')
  @Header('Cache-Control', 'no-store')
  @Paged()
  @ApiOperation({
    summary: 'A service account’s tokens',
    description:
      'Newest first, revoked and expired ones included, with expiry and last use: never a token itself. Needs `admin.roles`.',
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ standardSchema: ServiceTokenPageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('admin.roles')
  async tokens(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof ServiceTokenPageDocument>> {
    const result = await this.listTokens.handle({
      actor,
      serviceAccountId,
      page,
    });
    return toPagedDocument(req, page, result, toServiceTokenResource);
  }

  @Post(':serviceAccountId/tokens')
  // The answer holds the token: no cache may keep it.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Issue a token',
    description: `A new bearer token for the service account, in \`meta.token\`: **shown only in this answer**; only its hash is stored. It expires (by default in 90 days, at most 366); send it as \`Authorization: Bearer <token>\`. Recorded as \`service-token.issue\` (its ID and expiry, never the token). ${APPLIES}`,
  })
  @ApiParam(ACCOUNT_ID)
  @ApiCreatedResponse({ standardSchema: IssuedServiceTokenDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`service-account-deactivated`: reactivate it first. `too-many-tokens`: it holds 10 tokens neither revoked nor expired.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description:
      '`invalid-expiry`: `expiresAt` is not in the future, or more than 366 days ahead.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async issue(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
    @Body({ schema: IssueServiceTokenDocument })
    body: IssueServiceTokenDocument,
  ): Promise<z.infer<typeof IssuedServiceTokenDocument>> {
    const { name, expiresAt } = body.data.attributes;
    const { token, secret } = await this.issueToken.handle({
      actor,
      serviceAccountId,
      name,
      ...(expiresAt !== undefined && { expiresAt: new Date(expiresAt) }),
    });
    return { data: toServiceTokenResource(token), meta: { token: secret } };
  }

  @Post(':serviceAccountId/tokens/:tokenId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke a token',
    description: `From the next request on the token is refused (401 \`token-revoked\`). It stays listed, with when it was revoked. Recorded as \`service-token.revoke\`. ${APPLIES}`,
  })
  @ApiParam(ACCOUNT_ID)
  @ApiParam(TOKEN_ID)
  @ApiOkResponse({ standardSchema: ServiceTokenDocument })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no such service account, or no such token of it.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description: '`already-revoked`: it is.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('serviceAccountId') serviceAccountId: string,
    @Param('tokenId') tokenId: string,
  ): Promise<z.infer<typeof ServiceTokenDocument>> {
    return {
      data: toServiceTokenResource(
        await this.revokeToken.handle({ actor, serviceAccountId, tokenId }),
      ),
    };
  }
}

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

function toRoleLinkage(roleIds: readonly string[]): RolesDoc {
  return { data: roleIds.map((id) => ({ type: 'Role' as const, id })) };
}
