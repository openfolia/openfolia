import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import { Public } from '../../base/api/public.decorator.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CreateGroupMappingAction,
  DeleteGroupMappingAction,
  GetGroupMappingAction,
  ListGroupMappingsAction,
} from '../core/actions/group-mappings.action.js';
import {
  ListIdentityProvidersAction,
  SignOutAction,
} from '../core/actions/sign-in.action.js';
import type { Actor } from '../core/actor.js';
import { ApiPermission } from './api-permission.decorator.js';
import { clearCookie, cookieOf, SESSION_COOKIE } from './session-cookies.js';
import { SignInSettings } from './sign-in-settings.js';
import {
  CreateGroupMappingDocument,
  GroupMappingDocument,
  GroupMappingPageDocument,
  groupMappingFilters,
  IdentityProviderPageDocument,
  SignedOutDocument,
  toGroupMappingResource,
  toIdentityProviderResource,
} from './sign-in.resources.js';

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere; nothing of it was written. `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
};

const MAPPING_ID = {
  name: 'mappingId',
  description: 'The mapping’s ID (a UUID). One that names no mapping is 404.',
  schema: { type: 'string' },
} as const;

/**
 * Sign-in for the editor (#37): the providers to offer, signing out, and
 * the group mappings (which group's members hold which role). The
 * browser's redirects are in `SignInController`.
 */
@ApiTags('sign-in')
@Controller()
@JsonApi()
export class AuthController {
  constructor(
    private readonly listProviders: ListIdentityProvidersAction,
    private readonly signOutAction: SignOutAction,
    private readonly listMappings: ListGroupMappingsAction,
    private readonly getMapping: GetGroupMappingAction,
    private readonly createMapping: CreateGroupMappingAction,
    private readonly deleteMapping: DeleteGroupMappingAction,
    private readonly settings: SignInSettings,
  ) {}

  @Get('auth/providers')
  @Public()
  @Paged()
  @ApiOperation({
    summary: 'Identity providers',
    description:
      'The identity providers people may sign in with, for the sign-in page’s buttons: empty when sign-in is not set up (`CCMS_OIDC_ISSUER`; never in demo mode). Anyone may ask, before signing in.',
  })
  @ApiOkResponse({ standardSchema: IdentityProviderPageDocument })
  providers(
    @Req() req: Request,
    @PageParams() page: PageRequest,
  ): z.infer<typeof IdentityProviderPageDocument> {
    return toPagedDocument(
      req,
      page,
      this.listProviders.handle({ page }),
      toIdentityProviderResource,
    );
  }

  @Post('auth/sign-out')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign out',
    description:
      "Ends the session of the request's cookie (`__Host-openfolia-session`) and removes the cookie, recorded as `user.sign-out`. Answers the identity provider's sign-out address in `meta.signOutUrl` (coming back to the editor's sign-in page, which must be registered with the provider as a post-logout redirect), or null. Always 200, with or without a session.",
  })
  @ApiOkResponse({ standardSchema: SignedOutDocument })
  async signOut(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof SignedOutDocument>> {
    const token = cookieOf(req, SESSION_COOKIE);
    clearCookie(res, SESSION_COOKIE);
    const { signOutUrl } = await this.signOutAction.handle({
      token,
      returnTo: this.settings.editorAddress('/sign-in'),
    });
    return { meta: { signOutUrl: signOutUrl ?? null } };
  }

  @Get('group-mappings')
  @Header('Cache-Control', 'no-store')
  @Paged()
  @Filters(
    { name: 'group', description: 'Only the mappings of this group (exact).' },
    {
      name: 'role',
      description: 'Only the mappings giving this role (its ID).',
    },
  )
  @ApiOperation({
    summary: 'Group mappings',
    description:
      'Which identity-provider group’s members hold which role, by group, then role. A person’s groups are those the provider sent at their last sign-in. Needs `admin.roles`.',
  })
  @ApiOkResponse({ standardSchema: GroupMappingPageDocument })
  @ApiPermission('admin.roles')
  async mappings(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[group]', { schema: groupMappingFilters.group.optional() })
    group?: string,
    @Query('filter[role]', { schema: groupMappingFilters.role.optional() })
    role?: string,
  ): Promise<z.infer<typeof GroupMappingPageDocument>> {
    const result = await this.listMappings.handle({
      actor,
      page,
      filter: {
        ...(group !== undefined && { group }),
        ...(role !== undefined && { role }),
      },
    });
    return toPagedDocument(req, page, result, toGroupMappingResource);
  }

  @Get('group-mappings/:mappingId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A group mapping',
    description: 'Needs `admin.roles`.',
  })
  @ApiParam(MAPPING_ID)
  @ApiOkResponse({ standardSchema: GroupMappingDocument })
  @ApiNotFoundResponse({
    description: '`not-found`: no mapping with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiPermission('admin.roles')
  async mapping(
    @CurrentActor() actor: Actor,
    @Param('mappingId') id: string,
  ): Promise<z.infer<typeof GroupMappingDocument>> {
    return {
      data: toGroupMappingResource(await this.getMapping.handle({ actor, id })),
    };
  }

  @Post('group-mappings')
  @ApiOperation({
    summary: 'Map a group to a role',
    description:
      'The group’s members hold the role: at once for everyone the provider last put in the group, at sign-in for the others. Recorded as `group-mapping.create`, and `role.assign` (`data.via` `groups`) per user given the role. Needs `admin.roles`.',
  })
  @ApiCreatedResponse({
    standardSchema: GroupMappingDocument,
    headers: {
      Location: { description: 'The new mapping.', schema: { type: 'string' } },
    },
  })
  @ApiConflictResponse({
    description: '`group-mapping-exists`: the group holds the role already.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse({
    description: '`unknown-role`: no such role (`meta.roles`).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async create(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateGroupMappingDocument })
    body: CreateGroupMappingDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof GroupMappingDocument>> {
    const mapping = await this.createMapping.handle({
      actor,
      group: body.data.attributes.group,
      roleId: body.data.relationships.role.data.id,
    });
    res.setHeader('Location', `/group-mappings/${mapping.id}`);
    return { data: toGroupMappingResource(mapping) };
  }

  @Delete('group-mappings/:mappingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a group mapping',
    description:
      'The group’s members lose the role at once (a direct assignment of it stays). Recorded as `group-mapping.delete`, and `role.unassign` (`data.via` `groups`) per user losing the role. Needs `admin.roles`.',
  })
  @ApiParam(MAPPING_ID)
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({
    description: '`not-found`: no mapping with this ID.',
    standardSchema: ErrorDocument,
  })
  @ApiConflictResponse({
    description:
      '`last-admin`: it would leave no active user holding `admin.roles`.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async delete(
    @CurrentActor() actor: Actor,
    @Param('mappingId') id: string,
  ): Promise<void> {
    await this.deleteMapping.handle({ actor, id });
  }
}
