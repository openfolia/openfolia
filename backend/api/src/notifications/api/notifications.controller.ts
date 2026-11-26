import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiNotModifiedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { NotModified } from '../../base/api/json-api.exception.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import { NamesPeople } from '../../base/api/people.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CountUnreadNotificationsAction,
  GetNotificationAction,
  ListNotificationsAction,
} from '../core/actions/list-notifications.action.js';
import { MarkNotificationsReadAction } from '../core/actions/mark-notifications-read.action.js';
import { NotificationId } from '../core/notification.js';
import {
  MarkReadDocument,
  MarkReadResultDocument,
  NotificationDocument,
  notificationFilters,
  NotificationPageDocument,
  toNotificationResource,
  UnreadCountDocument,
} from './notification.resources.js';

const OWN_ONLY =
  'Only your own notifications: nobody reads or marks another person’s. A service (the API token) has none. Any actor; no permission needed.';

/** Who the answer is for, in its ETag: a 304 never stands for another person's inbox. */
function etagOf(actor: Actor, count: number, latest: string | undefined) {
  const hash = createHash('sha256')
    .update(JSON.stringify([actor.kind, actor.id, count, latest ?? null]))
    .digest('base64url');
  return `"${hash}"`;
}

@ApiTags('notifications')
@Controller('me/notifications')
@JsonApi()
export class NotificationsController {
  constructor(
    private readonly listNotifications: ListNotificationsAction,
    private readonly getNotification: GetNotificationAction,
    private readonly countUnread: CountUnreadNotificationsAction,
    private readonly markRead: MarkNotificationsReadAction,
  ) {}

  @Get()
  @NamesPeople()
  @Paged()
  @Filters({
    name: 'unread',
    description:
      '`true`: only unread notifications; `false`: only read ones. Left out: all.',
  })
  @ApiOperation({
    summary: 'List your notifications',
    description: `Your inbox, newest first: what concerns you (a change set to review, yours returned, approved, signed off or merged, your locks broken, your import done or failed, a release’s output failing, a major release of a manual you read), never what you caused yourself. \`meta.unreadCount\` counts your unread ones whatever the filter. ${OWN_ONLY}`,
  })
  @ApiOkResponse({ standardSchema: NotificationPageDocument })
  async list(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
    @Query('filter[unread]', { schema: notificationFilters.unread.optional() })
    unread?: boolean,
  ): Promise<z.infer<typeof NotificationPageDocument>> {
    const result = await this.listNotifications.handle({
      actor,
      page,
      filter: unread === undefined ? {} : { unread },
    });
    res.setHeader('Cache-Control', 'private, no-store');
    const document = toPagedDocument(req, page, result, toNotificationResource);
    return {
      ...document,
      meta: { ...document.meta, unreadCount: result.unreadCount },
    };
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Count your unread notifications',
    description: `For the bell: how many of your notifications are unread, and your newest one’s ID. Cheap, for polling: send the \`ETag\` back as \`If-None-Match\`, and while nothing changed the answer is 304 without a body. ${OWN_ONLY}`,
  })
  @ApiOkResponse({
    standardSchema: UnreadCountDocument,
    headers: {
      ETag: {
        description:
          'Changes when the count or your newest notification does; for `If-None-Match`.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiNotModifiedResponse({
    description: 'The `If-None-Match` ETag is still current.',
  })
  async unreadCount(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof UnreadCountDocument>> {
    const { count, latest } = await this.countUnread.handle({ actor });
    const etag = etagOf(actor, count, latest);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.vary('Authorization');
    res.vary('X-Ccms-User');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) throw new NotModified(etag);
    return { meta: { unreadCount: count, latest: latest ?? null } };
  }

  @Get(':notificationId')
  @NamesPeople()
  @ApiOperation({
    summary: 'Read one of your notifications',
    description: `Another person’s is 404, exactly like one that does not exist. ${OWN_ONLY}`,
  })
  @ApiParam({
    name: 'notificationId',
    description:
      'The notification’s ID (a positive whole number). One that is not yours, malformed or not, is 404.',
    schema: { type: 'string' },
  })
  @ApiOkResponse({ standardSchema: NotificationDocument })
  @ApiNotFoundResponse({
    description:
      '`not-found`: no notification of yours with this ID (another person’s is answered alike).',
    standardSchema: ErrorDocument,
  })
  async get(
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @Param('notificationId') id: string,
  ): Promise<z.infer<typeof NotificationDocument>> {
    res.setHeader('Cache-Control', 'private, no-store');
    // A malformed ID names no notification: 404 like any other.
    const notification = await this.getNotification.handle({
      actor,
      id: NotificationId.safeParse(id).success ? id : '0',
    });
    return { data: toNotificationResource(notification) };
  }

  @Post('read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark your notifications read',
    description: `\`{ meta: { ids: [...] } }\` marks those (1 to 200), \`{ meta: { all: true } }\` all of yours. One already read keeps when it was read. Answers how many were marked and how many are still unread. ${OWN_ONLY}`,
  })
  @ApiOkResponse({ standardSchema: MarkReadResultDocument })
  @ApiNotFoundResponse({
    description:
      '`not-found`: an ID names no notification of yours (another person’s is answered alike); nothing was marked.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse({
    description:
      '`database-timeout`: the transaction waited too long for a row held elsewhere, or a statement ran too long; nothing was marked. `Retry-After` says when to try again.',
    standardSchema: ErrorDocument,
  })
  async read(
    @CurrentActor() actor: Actor,
    @Body({ schema: MarkReadDocument }) body: MarkReadDocument,
  ): Promise<z.infer<typeof MarkReadResultDocument>> {
    const ids = 'all' in body.meta ? ('all' as const) : body.meta.ids;
    return { meta: await this.markRead.handle({ actor, ids }) };
  }
}
