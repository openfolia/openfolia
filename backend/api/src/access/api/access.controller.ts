import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { z } from 'zod';
import { ApiPermission } from './api-permission.decorator.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import type { Env } from '../../config/env.js';
import { GetMeAction } from '../core/actions/get-me.action.js';
import { ListDemoUsersAction } from '../core/actions/list-demo-users.action.js';
import { ListUsersAction } from '../core/actions/list-users.action.js';
import type { Actor } from '../core/actor.js';
import {
  ActorDocument,
  toActorResource,
  toUserResource,
  UserPageDocument,
  userFilters,
} from './access.resources.js';

@ApiTags('access')
@Controller()
@JsonApi()
export class AccessController {
  constructor(
    private readonly getMe: GetMeAction,
    private readonly listUsers: ListUsersAction,
    private readonly listDemoUsers: ListDemoUsersAction,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('me')
  // About the caller: never stored by a cache, not even a private one.
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Who is calling',
    description:
      'The actor this request acts as: the user (signed in, #37; in demo mode, the one `X-Ccms-User` names) or the read-only service of the shared token, with its roles and effective permissions. `meta.session` when it acts through a signed-in session.',
  })
  @ApiOkResponse({ standardSchema: ActorDocument })
  async me(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof ActorDocument>> {
    return {
      data: toActorResource(
        await this.getMe.handle({ actor }),
        req.signInSession,
      ),
    };
  }

  @Get('users')
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
        'Only users whose ID, name or email address contains this text, ignoring case.',
    },
  )
  @ApiOperation({
    summary: 'Users',
    description:
      'Users by ID, deactivated ones included, with their email address and the roles assigned to them. Needs `admin.roles`.',
  })
  @ApiOkResponse({ standardSchema: UserPageDocument })
  @ApiPermission('admin.roles')
  async users(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[role]', { schema: userFilters.role.optional() })
    role?: string,
    @Query('filter[status]', { schema: userFilters.status.optional() })
    status?: 'active' | 'deactivated',
    @Query('filter[q]', { schema: userFilters.q.optional() })
    q?: string,
  ): Promise<z.infer<typeof UserPageDocument>> {
    const result = await this.listUsers.handle({
      actor,
      page,
      filter: {
        ...(role !== undefined && { role }),
        ...(status !== undefined && { active: status === 'active' }),
        ...(q !== undefined && { q }),
      },
    });
    return toPagedDocument(req, page, result, (user) => toUserResource(user));
  }

  @Get('demo/users')
  @Header('Cache-Control', 'no-store')
  @Paged()
  @ApiOperation({
    summary: 'Users to act as (demo mode)',
    description:
      'Demo mode only (`CCMS_AUTH_MODE=demo`): the active users `X-Ccms-User` may name, for a user switcher, to any actor with the token (without email addresses). 404 `not-found` when demo mode is off, which is how a client learns it is.',
  })
  @ApiOkResponse({ standardSchema: UserPageDocument })
  async demoUsers(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof UserPageDocument>> {
    const result = await this.listDemoUsers.handle({
      actor,
      page,
      demo: this.config.get('CCMS_AUTH_MODE', { infer: true }) === 'demo',
    });
    // Any token holder calls it: no email addresses.
    return toPagedDocument(req, page, result, (user) =>
      toUserResource(user, { withEmail: false }),
    );
  }
}
