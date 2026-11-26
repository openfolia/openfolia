import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { authorize } from '../../access/core/policy.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { NotFoundError } from '../../base/core/errors.js';
import type { Env } from '../../config/env.js';
import {
  CreateScimGroupAction,
  DeleteScimGroupAction,
  GetScimGroupAction,
  ListScimGroupsAction,
  PatchScimGroupAction,
  ReplaceScimGroupAction,
} from '../core/actions/scim-groups.action.js';
import {
  CreateScimUserAction,
  DeleteScimUserAction,
  GetScimUserAction,
  ListScimUsersAction,
  PatchScimUserAction,
  ReplaceScimUserAction,
} from '../core/actions/scim-users.action.js';
import { directoryOnly, SCIM_PERMISSION } from '../core/scim-access.js';
import { ScimInvalidValueError } from '../core/scim-errors.js';
import type { JsonObject } from '../core/scim-json.js';
import { DEFAULT_COUNT, MAX_COUNT, type ScimPage } from '../core/scim-list.js';
import { patchOperationsOf, userOperationsOf } from '../core/scim-patch.js';
import {
  groupResource,
  type ScimGroup,
  type ScimUser,
  userResource,
} from '../core/scim-resources.js';
import {
  resourceTypes,
  scimSchemas,
  serviceProviderConfig,
} from './scim-discovery.js';
import { Scim } from './scim-http.js';
import {
  project,
  ScimDiscoveryList,
  ScimDiscoveryResource,
  ScimErrorDocument,
  ScimGroupList,
  ScimGroupResource,
  ScimUserList,
  ScimUserResource,
  toListResponse,
} from './scim.resources.js';

const LIST_QUERIES = [
  {
    name: 'filter',
    required: false,
    description:
      'A SCIM filter (RFC 7644, section 3.4.2.2): `userName eq "jane@example.org"`, `externalId eq "…"`, `emails[type eq "work" and value co "@example.org"]`, with `and`, `or`, `not` and every operator of the standard. 400 `invalidFilter` for one that does not parse.',
    schema: { type: 'string' },
  },
  {
    name: 'startIndex',
    required: false,
    description: 'The first result, from 1. Default: 1.',
    schema: { type: 'integer', minimum: 1 },
  },
  {
    name: 'count',
    required: false,
    description: `Results per page. Default: ${DEFAULT_COUNT}, at most ${MAX_COUNT} (more is cut to it).`,
    schema: { type: 'integer', minimum: 0 },
  },
] as const;

const PROJECTION_QUERIES = [
  {
    name: 'attributes',
    required: false,
    description:
      'Only these attributes (comma-separated attribute paths), with `id` and `schemas`.',
    schema: { type: 'string' },
  },
  {
    name: 'excludedAttributes',
    required: false,
    description: 'Without these attributes (comma-separated), e.g. `members`.',
    schema: { type: 'string' },
  },
] as const;

const USER_ID = {
  name: 'userId',
  description: 'The user’s ID. One no directory provisioned is 404.',
  schema: { type: 'string' },
} as const;

const GROUP_ID = {
  name: 'groupId',
  description:
    'The group’s ID (a UUID). One that names no provisioned group is 404.',
  schema: { type: 'string' },
} as const;

const ERROR = (description: string) => ({
  description,
  standardSchema: ScimErrorDocument,
});

const NOT_FOUND = ERROR('No such resource.');
const INVALID = ERROR(
  'The standard’s 400s, with their `scimType`: `invalidSyntax` (no resource or PatchOp), `invalidValue` (an attribute missing or out of range, a member that is no provisioned user), `invalidPath` and `noTarget` (a patch path), `mutability` (a read-only attribute), `invalidFilter`. Or a query parameter SCIM does not define.',
);
const USER_CONFLICT = ERROR(
  '`uniqueness`: another provisioned user has the `userName`, or another user the email address (one not linked by the link-by-email setting). Or (no `scimType`): the user was linked rather than made by the directory, has signed in, or holds a permission beyond reading and writing content, so only the editor changes their address (`scim-address-locked`); or the change would leave no active user holding `admin.roles` (`last-admin`).',
);

const ACCESS =
  'Needs a service account’s token whose roles hold `scim.provision`; anyone else is 403, a person too.';
const APPLIES =
  'Applies at once, and is recorded in the audit log (`data.via` `scim`).';

/**
 * SCIM 2.0 (#377): a directory provisions users and groups (`/scim/v2`), with a service
 * account's token that holds `scim.provision`. SCIM's own media type, paging (`startIndex`,
 * `count`) and errors (`ScimInterceptor`, `ScimExceptionFilter`), beside the JSON:API
 * conventions of every other route.
 */
@ApiTags('scim')
@Controller('scim/v2')
@Scim()
export class ScimController {
  /** Where the SCIM routes are reached from outside: `meta.location` starts with it. */
  private readonly base: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly listUsers: ListScimUsersAction,
    private readonly getUser: GetScimUserAction,
    private readonly createUser: CreateScimUserAction,
    private readonly replaceUser: ReplaceScimUserAction,
    private readonly patchUser: PatchScimUserAction,
    private readonly deleteUser: DeleteScimUserAction,
    private readonly listGroups: ListScimGroupsAction,
    private readonly getGroup: GetScimGroupAction,
    private readonly createGroup: CreateScimGroupAction,
    private readonly replaceGroup: ReplaceScimGroupAction,
    private readonly patchGroup: PatchScimGroupAction,
    private readonly deleteGroup: DeleteScimGroupAction,
  ) {
    // Behind the editor, the API answers under `/api` (`deploy/docker/editor/nginx.conf`).
    const publicUrl = config.get('CCMS_PUBLIC_URL', { infer: true });
    this.base = publicUrl
      ? `${publicUrl.replace(/\/+$/, '')}/api/scim/v2`
      : '/scim/v2';
  }

  @Get('ServiceProviderConfig')
  @ApiOperation({
    summary: 'SCIM: what is supported',
    description: `Patch and filters; no bulk, sorting, ETags or password changes. ${ACCESS}`,
  })
  @ApiOkResponse({ standardSchema: ScimDiscoveryResource })
  @ApiPermission(SCIM_PERMISSION)
  config(@CurrentActor() actor: Actor): JsonObject {
    this.discovery(actor);
    return serviceProviderConfig(this.base);
  }

  @Get('ResourceTypes')
  @ApiOperation({ summary: 'SCIM: the resource types', description: ACCESS })
  @ApiOkResponse({ standardSchema: ScimDiscoveryList })
  @ApiPermission(SCIM_PERMISSION)
  types(@CurrentActor() actor: Actor): JsonObject {
    this.discovery(actor);
    const all = resourceTypes(this.base);
    return toListResponse(
      { total: all.length, startIndex: 1, items: all },
      (t) => t,
    );
  }

  @Get('ResourceTypes/:resourceTypeId')
  @ApiOperation({ summary: 'SCIM: a resource type', description: ACCESS })
  @ApiParam({ name: 'resourceTypeId', description: '`User` or `Group`.' })
  @ApiOkResponse({ standardSchema: ScimDiscoveryResource })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission(SCIM_PERMISSION)
  type(
    @CurrentActor() actor: Actor,
    @Param('resourceTypeId') id: string,
  ): JsonObject {
    this.discovery(actor);
    const found = resourceTypes(this.base).find((t) => t['id'] === id);
    if (!found) throw new NotFoundError(`No resource type "${id}".`);
    return found;
  }

  @Get('Schemas')
  @ApiOperation({
    summary: 'SCIM: the schemas',
    description: `User, Group and the enterprise user extension. ${ACCESS}`,
  })
  @ApiOkResponse({ standardSchema: ScimDiscoveryList })
  @ApiPermission(SCIM_PERMISSION)
  schemas(@CurrentActor() actor: Actor): JsonObject {
    this.discovery(actor);
    const all = scimSchemas(this.base);
    return toListResponse(
      { total: all.length, startIndex: 1, items: all },
      (s) => s,
    );
  }

  @Get('Schemas/:schemaId')
  @ApiOperation({ summary: 'SCIM: a schema', description: ACCESS })
  @ApiParam({ name: 'schemaId', description: 'The schema’s URN.' })
  @ApiOkResponse({ standardSchema: ScimDiscoveryResource })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission(SCIM_PERMISSION)
  schema(
    @CurrentActor() actor: Actor,
    @Param('schemaId') id: string,
  ): JsonObject {
    this.discovery(actor);
    const found = scimSchemas(this.base).find((s) => s['id'] === id);
    if (!found) throw new NotFoundError(`No schema "${id}".`);
    return found;
  }

  @Get('Users')
  @ApiOperation({
    summary: 'SCIM: the provisioned users',
    description: `Filtered and paged as SCIM does it, by ID. Only users a directory provisioned. ${ACCESS}`,
  })
  @ApiQuery(LIST_QUERIES[0])
  @ApiQuery(LIST_QUERIES[1])
  @ApiQuery(LIST_QUERIES[2])
  @ApiQuery(PROJECTION_QUERIES[0])
  @ApiQuery(PROJECTION_QUERIES[1])
  @ApiOkResponse({ standardSchema: ScimUserList })
  @ApiBadRequestResponse(INVALID)
  @ApiPermission(SCIM_PERMISSION)
  async users(
    @CurrentActor() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<JsonObject> {
    const listed = await this.listUsers.handle({
      actor,
      ...filterOf(query),
      page: pageOf(query),
    });
    return toListResponse(listed, (u) => this.projectUser(u, query));
  }

  @Get('Users/:userId')
  @ApiOperation({ summary: 'SCIM: a provisioned user', description: ACCESS })
  @ApiParam(USER_ID)
  @ApiQuery(PROJECTION_QUERIES[0])
  @ApiQuery(PROJECTION_QUERIES[1])
  @ApiOkResponse({ standardSchema: ScimUserResource })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission(SCIM_PERMISSION)
  async user(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<JsonObject> {
    return this.projectUser(
      await this.getUser.handle({ actor, userId }),
      query,
    );
  }

  @Post('Users')
  @ApiOperation({
    summary: 'SCIM: provision a user',
    description: `A new user, its ID made from \`userName\`; or an existing one taken over by its email address where the link-by-email setting (\`CCMS_OIDC_LINK_BY_EMAIL\`) allows it, never one deactivated or holding a permission beyond reading and writing content. Its name is \`displayName\` (else \`name\`, else \`userName\`), its address the primary of \`emails\`. A password is never kept. ${APPLIES} ${ACCESS}`,
  })
  @ApiBody({ schema: { type: 'object' }, description: 'A SCIM User resource.' })
  @ApiCreatedResponse({
    standardSchema: ScimUserResource,
    headers: {
      Location: { description: 'The new user.', schema: { type: 'string' } },
    },
  })
  @ApiBadRequestResponse(INVALID)
  @ApiConflictResponse(USER_CONFLICT)
  @ApiPermission(SCIM_PERMISSION)
  async addUser(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<JsonObject> {
    const user = this.userOf(await this.createUser.handle({ actor, body }));
    res.setHeader('Location', locationOf(user));
    return user;
  }

  @Put('Users/:userId')
  @ApiOperation({
    summary: 'SCIM: replace a provisioned user',
    description: `Its name, address, attributes and \`active\`: false deactivates it at once (its sessions end, its locks are released; its change sets and comments stay), true lets it act again, left out it stays as it is. One that sets it to false deactivates whatever else in it is wrong (nothing else of it may then be kept), but for the last admin. ${APPLIES} ${ACCESS}`,
  })
  @ApiParam(USER_ID)
  @ApiBody({ schema: { type: 'object' }, description: 'A SCIM User resource.' })
  @ApiOkResponse({ standardSchema: ScimUserResource })
  @ApiBadRequestResponse(INVALID)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(USER_CONFLICT)
  @ApiPermission(SCIM_PERMISSION)
  async putUser(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<JsonObject> {
    return this.userOf(await this.replaceUser.handle({ actor, userId, body }));
  }

  @Patch('Users/:userId')
  @ApiOperation({
    summary: 'SCIM: change a provisioned user',
    description: `SCIM PATCH operations (\`add\`, \`replace\`, \`remove\`, with paths and value filters), then saved as a PUT would be; one that leaves \`active\` false deactivates whatever else in it is wrong, as there. ${APPLIES} ${ACCESS}`,
  })
  @ApiParam(USER_ID)
  @ApiBody({ schema: { type: 'object' }, description: 'A SCIM PatchOp.' })
  @ApiOkResponse({ standardSchema: ScimUserResource })
  @ApiBadRequestResponse(INVALID)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(USER_CONFLICT)
  @ApiPermission(SCIM_PERMISSION)
  async changeUser(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ): Promise<JsonObject> {
    directoryOnly(actor);
    const operations = userOperationsOf(body);
    return this.userOf(
      await this.patchUser.handle({ actor, userId, operations }),
    );
  }

  @Delete('Users/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'SCIM: let a provisioned user go',
    description: `Deactivated at once (its sessions end, its locks are released), no longer provisioned and out of every group; the user stays, with its change sets and comments, shown as deactivated. Provisioning its address again brings the same user back, unless the link-by-email setting is off or an admin reactivated or deactivated it since. ${APPLIES} ${ACCESS}`,
  })
  @ApiParam(USER_ID)
  @ApiNoContentResponse({ description: 'Let go.' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(
    ERROR('`last-admin`: it is the last active user holding `admin.roles`.'),
  )
  @ApiPermission(SCIM_PERMISSION)
  async removeUser(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.deleteUser.handle({ actor, userId });
  }

  @Get('Groups')
  @ApiOperation({
    summary: 'SCIM: the provisioned groups',
    description: `Filtered and paged as SCIM does it, by name. ${ACCESS}`,
  })
  @ApiQuery(LIST_QUERIES[0])
  @ApiQuery(LIST_QUERIES[1])
  @ApiQuery(LIST_QUERIES[2])
  @ApiQuery(PROJECTION_QUERIES[0])
  @ApiQuery(PROJECTION_QUERIES[1])
  @ApiOkResponse({ standardSchema: ScimGroupList })
  @ApiBadRequestResponse(INVALID)
  @ApiPermission(SCIM_PERMISSION)
  async groups(
    @CurrentActor() actor: Actor,
    @Query() query: Record<string, unknown>,
  ): Promise<JsonObject> {
    const listed = await this.listGroups.handle({
      actor,
      ...filterOf(query),
      page: pageOf(query),
    });
    return toListResponse(listed, (g) => this.projectGroup(g, query));
  }

  @Get('Groups/:groupId')
  @ApiOperation({ summary: 'SCIM: a provisioned group', description: ACCESS })
  @ApiParam(GROUP_ID)
  @ApiQuery(PROJECTION_QUERIES[0])
  @ApiQuery(PROJECTION_QUERIES[1])
  @ApiOkResponse({ standardSchema: ScimGroupResource })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission(SCIM_PERMISSION)
  async group(
    @CurrentActor() actor: Actor,
    @Param('groupId') groupId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<JsonObject> {
    return this.projectGroup(
      await this.getGroup.handle({ actor, groupId }),
      query,
    );
  }

  @Post('Groups')
  @ApiOperation({
    summary: 'SCIM: provision a group',
    description: `A group and its members (provisioned users): they gain at once the roles the group mappings give the group's \`displayName\`. ${APPLIES} ${ACCESS}`,
  })
  @ApiBody({
    schema: { type: 'object' },
    description: 'A SCIM Group resource.',
  })
  @ApiCreatedResponse({
    standardSchema: ScimGroupResource,
    headers: {
      Location: { description: 'The new group.', schema: { type: 'string' } },
    },
  })
  @ApiBadRequestResponse(INVALID)
  @ApiConflictResponse(
    ERROR('`uniqueness`: another provisioned group has the `displayName`.'),
  )
  @ApiPermission(SCIM_PERMISSION)
  async addGroup(
    @CurrentActor() actor: Actor,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<JsonObject> {
    const group = this.groupOf(await this.createGroup.handle({ actor, body }));
    res.setHeader('Location', locationOf(group));
    return group;
  }

  @Put('Groups/:groupId')
  @ApiOperation({
    summary: 'SCIM: replace a provisioned group',
    description: `Its name and members: whoever joins or leaves gains or loses what the mappings give. ${APPLIES} ${ACCESS}`,
  })
  @ApiParam(GROUP_ID)
  @ApiBody({
    schema: { type: 'object' },
    description: 'A SCIM Group resource.',
  })
  @ApiOkResponse({ standardSchema: ScimGroupResource })
  @ApiBadRequestResponse(INVALID)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(
    ERROR(
      '`uniqueness`: another group has the `displayName`. `last-admin`: it would leave no admin.',
    ),
  )
  @ApiPermission(SCIM_PERMISSION)
  async putGroup(
    @CurrentActor() actor: Actor,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<JsonObject> {
    return this.groupOf(
      await this.replaceGroup.handle({ actor, groupId, body }),
    );
  }

  @Patch('Groups/:groupId')
  @ApiOperation({
    summary: 'SCIM: change a provisioned group',
    description: `SCIM PATCH operations: members added (\`add\` to \`members\`) and removed (\`remove\` of \`members[value eq "…"]\`, or of \`members\` with the values), a new name. ${APPLIES} ${ACCESS}`,
  })
  @ApiParam(GROUP_ID)
  @ApiBody({ schema: { type: 'object' }, description: 'A SCIM PatchOp.' })
  @ApiOkResponse({ standardSchema: ScimGroupResource })
  @ApiBadRequestResponse(INVALID)
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(
    ERROR(
      '`uniqueness`: another group has the `displayName`. `last-admin`: it would leave no admin.',
    ),
  )
  @ApiPermission(SCIM_PERMISSION)
  async changeGroup(
    @CurrentActor() actor: Actor,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ): Promise<JsonObject> {
    directoryOnly(actor);
    const operations = patchOperationsOf(body);
    return this.groupOf(
      await this.patchGroup.handle({ actor, groupId, operations }),
    );
  }

  @Delete('Groups/:groupId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'SCIM: remove a provisioned group',
    description: `Its members lose what its mappings gave. ${APPLIES} ${ACCESS}`,
  })
  @ApiParam(GROUP_ID)
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse(ERROR('`last-admin`: it would leave no admin.'))
  @ApiPermission(SCIM_PERMISSION)
  async removeGroup(
    @CurrentActor() actor: Actor,
    @Param('groupId') groupId: string,
  ): Promise<void> {
    await this.deleteGroup.handle({ actor, groupId });
  }

  /** A discovery route: the same permission as every other SCIM route. */
  private discovery(actor: Actor): void {
    authorize(actor, SCIM_PERMISSION);
    directoryOnly(actor);
  }

  private userOf(user: ScimUser): JsonObject {
    return withLocation(
      userResource(user),
      `${this.base}/Users/${user.userId}`,
    );
  }

  private groupOf(group: ScimGroup): JsonObject {
    return withLocation(
      groupResource(group),
      `${this.base}/Groups/${group.id}`,
    );
  }

  private projectUser(
    user: ScimUser,
    query: Record<string, unknown>,
  ): JsonObject {
    return project(
      this.userOf(user),
      text(query, 'attributes'),
      text(query, 'excludedAttributes'),
    );
  }

  private projectGroup(
    group: ScimGroup,
    query: Record<string, unknown>,
  ): JsonObject {
    return project(
      this.groupOf(group),
      text(query, 'attributes'),
      text(query, 'excludedAttributes'),
    );
  }
}

function withLocation(resource: JsonObject, location: string): JsonObject {
  return {
    ...resource,
    meta: { ...(resource['meta'] as JsonObject), location },
  };
}

const locationOf = (resource: JsonObject): string =>
  String((resource['meta'] as JsonObject)['location']);

/** A query parameter's text; 400 for one sent twice. */
function text(
  query: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ScimInvalidValueError(`"${name}" is sent once.`, name);
  }
  return value;
}

function filterOf(query: Record<string, unknown>): { filter?: string } {
  const filter = text(query, 'filter');
  return filter === undefined ? {} : { filter };
}

/** `startIndex` (below 1 is 1) and `count` (past `MAX_COUNT` is it), as the standard reads them. */
function pageOf(query: Record<string, unknown>): ScimPage {
  const whole = (name: string, fallback: number): number => {
    const value = text(query, name);
    if (value === undefined) return fallback;
    if (!/^-?\d{1,16}$/.test(value)) {
      throw new ScimInvalidValueError(`"${name}" is a whole number.`, name);
    }
    return Number(value);
  };
  return {
    startIndex: Math.max(1, whole('startIndex', 1)),
    count: Math.min(MAX_COUNT, Math.max(0, whole('count', DEFAULT_COUNT))),
  };
}
