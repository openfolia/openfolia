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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import {
  Filters,
  JsonApi,
  PageParams,
  Paged,
} from '../../base/api/json-api.decorators.js';
import { ErrorDocument, toPagedDocument } from '../../base/api/json-api.js';
import type { PageRequest } from '../../base/core/paging.js';
import {
  CreateWebhookAction,
  DeleteWebhookAction,
  GetWebhookAction,
  ListWebhookDeliveriesAction,
  ListWebhooksAction,
  RotateWebhookSecretAction,
  UpdateWebhookAction,
} from '../core/actions/manage-webhooks.action.js';
import {
  RetryWebhookDeliveryAction,
  TestWebhookAction,
} from '../core/actions/test-webhook.action.js';
import type {
  DeliveryEvent,
  DeliveryStatus,
  WebhookEvent,
} from '../core/webhook.js';
import {
  CreateWebhookDocument,
  deliveryFilters,
  toDeliveryResource,
  toWebhookResource,
  UpdateWebhookDocument,
  WebhookDeliveryDocument,
  WebhookDeliveryPageDocument,
  WebhookDocument,
  WebhookPageDocument,
  WEBHOOK_HEADER_LIMITS,
  WebhookWithSecretDocument,
} from './webhook.resources.js';

const WEBHOOK_ID = {
  name: 'webhookId',
  description: 'The webhook’s ID (a UUID). One that names no webhook is 404.',
  schema: { type: 'string' },
} as const;

const NOT_FOUND = {
  description:
    '`not-found`: no webhook with this ID. `not-configured`: webhooks are off on this server (no secret key: `CCMS_SECRET_KEY` unset and `CCMS_SECRET_KEY_GENERATE=false`), for the routes that make a secret.',
  standardSchema: ErrorDocument,
};

const INVALID_URL = {
  description:
    '`invalid-url`: not a URL deliveries may go to (`meta.problem`: `not-a-url`, `scheme` (not https), `credentials` (a user name or password in it), `fragment`, `too-long`, `blocked-address` (a private, loopback, link-local or otherwise non-public address, or `localhost`)).',
  standardSchema: ErrorDocument,
};

const INVALID = {
  description: `${INVALID_URL.description} The custom headers cannot be used: one error per problem, each with its own \`code\` and \`source.pointer\`: \`header-name-invalid\` (not an RFC 9110 token), \`header-name-refused\` (a name the server sets or that would break the delivery), \`header-name-duplicate\`, \`header-value-invalid\` (a line break, another control character or text outside ASCII), \`header-value-required\` (a header that is not secret, a new secret one, or every secret one when the URL changes), \`too-many-headers\` (more than 20), \`headers-too-large\` (more than 8,192 characters).`,
  standardSchema: ErrorDocument,
};

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long; nothing of it was written. `Retry-After` says when to try again.',
  standardSchema: ErrorDocument,
};

const MANAGES =
  'Needs `webhook.manage`, and is recorded in the audit log (never a secret, never the URL’s path or query).';

type WebhookDoc = z.infer<typeof WebhookDocument>;
type WithSecretDoc = z.infer<typeof WebhookWithSecretDocument>;

/**
 * Webhook subscribers and their delivery logs (#42): `webhook.manage`.
 * See the README, "Webhooks", for the events, the signature and the
 * receiver's recipe.
 */
@ApiTags('webhooks')
@Controller('webhooks')
@JsonApi()
export class WebhooksController {
  constructor(
    private readonly listWebhooks: ListWebhooksAction,
    private readonly getWebhook: GetWebhookAction,
    private readonly createWebhook: CreateWebhookAction,
    private readonly updateWebhook: UpdateWebhookAction,
    private readonly deleteWebhook: DeleteWebhookAction,
    private readonly rotateSecret: RotateWebhookSecretAction,
    private readonly listDeliveries: ListWebhookDeliveriesAction,
    private readonly testWebhook: TestWebhookAction,
    private readonly retryDelivery: RetryWebhookDeliveryAction,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Paged()
  @ApiOperation({
    summary: 'Webhooks',
    description:
      'Every subscriber the caller sees, oldest first, paused and disabled ones too; never a secret. `meta.headerLimits` holds the custom headers’ limits. Only its owner, or a manager whose reading scope covers any owner of one with its events, sees a webhook; to anyone else it does not exist (404, left out of lists). Needs `webhook.manage`.',
  })
  @ApiOkResponse({ standardSchema: WebhookPageDocument })
  @ApiPermission('webhook.manage')
  async list(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @PageParams() page: PageRequest,
  ): Promise<z.infer<typeof WebhookPageDocument>> {
    const result = await this.listWebhooks.handle({ actor, page });
    const doc = toPagedDocument(req, page, result, toWebhookResource);
    return {
      ...doc,
      meta: { ...doc.meta, headerLimits: WEBHOOK_HEADER_LIMITS },
    };
  }

  @Get(':webhookId')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A webhook',
    description:
      'Never its secret. Only its owner, or a manager whose reading scope covers any owner of one with its events, sees a webhook; to anyone else it does not exist (404, left out of lists). Needs `webhook.manage`.',
  })
  @ApiParam(WEBHOOK_ID)
  @ApiOkResponse({ standardSchema: WebhookDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('webhook.manage')
  async one(
    @CurrentActor() actor: Actor,
    @Param('webhookId') id: string,
  ): Promise<WebhookDoc> {
    return {
      data: toWebhookResource(await this.getWebhook.handle({ actor, id })),
    };
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Add a webhook',
    description: `A URL, the events to send it, a description, an optional audience limit (\`maxAudience\`) and custom headers (\`headers\`; a secret one's value is stored sealed and never shown again); active at once. Owned by the caller: it is sent only events about content they may read. Answers its signing secret **once**, in \`meta.secret\`; only a sealed copy is stored. At most 100 webhooks. Recorded as \`webhook.create\` (its host, events and the custom headers' names, never a value). ${MANAGES}`,
  })
  @ApiCreatedResponse({
    standardSchema: WebhookWithSecretDocument,
    headers: {
      Location: { description: 'The new webhook.', schema: { type: 'string' } },
    },
  })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: '`too-many-webhooks`: there are 100 already (`meta.max`).',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse(INVALID)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('webhook.manage')
  async create(
    @CurrentActor() actor: Actor,
    @Body({ schema: CreateWebhookDocument }) body: CreateWebhookDocument,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WithSecretDoc> {
    const { attributes } = body.data;
    const { webhook, secret } = await this.createWebhook.handle({
      actor,
      url: attributes.url,
      events: attributes.events as WebhookEvent[],
      description: attributes.description ?? null,
      maxAudience: attributes.maxAudience ?? null,
      ...(attributes.headers !== undefined && { headers: attributes.headers }),
    });
    res.setHeader('Location', `/webhooks/${webhook.id}`);
    return { data: toWebhookResource(webhook), meta: { secret } };
  }

  @Patch(':webhookId')
  @ApiOperation({
    summary: 'Change a webhook',
    description: `Its URL, events, description, audience limit or custom headers (\`headers\`, all of them: a secret one given without a value keeps its stored value, except when the URL changes: a secret is never sent to a receiver it was not given for); \`active: false\` pauses it and \`active: true\` resumes it (also one disabled for failing). What is left out stays, the secret too. Whoever points it at another URL becomes its owner: it is then sent what they may read, and the deliveries still waiting, made for the old owner, are skipped. Someone else changes its custom headers only with a reading scope that restricts nothing (403 \`forbidden\`), and its URL, events or audience limit only with a reading scope covering any owner of one with the old and the new events (403 \`forbidden\`); changing only its events keeps the owner. The secret stays: a new owner rotates it. Recorded as \`webhook.update\` (the fields changed; the custom headers changed by name). ${MANAGES}`,
  })
  @ApiParam(WEBHOOK_ID)
  @ApiOkResponse({ standardSchema: WebhookDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description: '`id-mismatch`: `data.id` is not the path’s.',
    standardSchema: ErrorDocument,
  })
  @ApiUnprocessableEntityResponse(INVALID)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('webhook.manage')
  async update(
    @CurrentActor() actor: Actor,
    @Param('webhookId') id: string,
    @Body({ schema: UpdateWebhookDocument }) body: UpdateWebhookDocument,
  ): Promise<WebhookDoc> {
    const a = body.data.attributes ?? {};
    const webhook = await this.updateWebhook.handle({
      actor,
      id,
      bodyId: body.data.id,
      changes: {
        ...(a.url !== undefined && { url: a.url }),
        ...(a.events !== undefined && { events: a.events as WebhookEvent[] }),
        ...(a.description !== undefined && { description: a.description }),
        ...(a.maxAudience !== undefined && { maxAudience: a.maxAudience }),
        ...(a.active !== undefined && { active: a.active }),
      },
      ...(a.headers !== undefined && { headers: a.headers }),
    });
    return { data: toWebhookResource(webhook) };
  }

  @Delete(':webhookId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a webhook',
    description: `With its delivery log; deliveries still waiting are not sent. Recorded as \`webhook.delete\`. ${MANAGES}`,
  })
  @ApiParam(WEBHOOK_ID)
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('webhook.manage')
  async delete(
    @CurrentActor() actor: Actor,
    @Param('webhookId') id: string,
  ): Promise<void> {
    await this.deleteWebhook.handle({ actor, id });
  }

  @Post(':webhookId/secret')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Rotate a webhook’s secret',
    description: `A new signing secret, answered **once** in \`meta.secret\`. The one before keeps signing beside it for a day (a second \`v1\` in \`X-Ccms-Signature\`, \`meta.previousSecretUntil\`), so the receiver can switch over without missing a delivery. Only its owner, or a manager whose reading scope covers any owner of any webhook, may rotate it (403 \`forbidden\`). No body. Recorded as \`webhook.rotate-secret\`. ${MANAGES}`,
  })
  @ApiParam(WEBHOOK_ID)
  @ApiOkResponse({ standardSchema: WebhookWithSecretDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('webhook.manage')
  async rotate(
    @CurrentActor() actor: Actor,
    @Param('webhookId') id: string,
  ): Promise<WithSecretDoc> {
    const { webhook, secret } = await this.rotateSecret.handle({ actor, id });
    return { data: toWebhookResource(webhook), meta: { secret } };
  }

  @Get(':webhookId/deliveries')
  @Header('Cache-Control', 'no-store')
  @Paged()
  @Filters(
    {
      name: 'status',
      description: '`pending`, `succeeded`, `failed` or `skipped`.',
    },
    { name: 'event', description: 'Only deliveries of this event.' },
  )
  @ApiOperation({
    summary: 'A webhook’s deliveries',
    description:
      'Its delivery log, newest first: each event sent, its body, status, attempts and the last attempt’s status code or error. Never a signature or secret. Settled deliveries are kept for `CCMS_WEBHOOKS_KEEP_DAYS` days. A body is null for a reader who may not see what the owner it was made for may. Needs `webhook.manage`.',
  })
  @ApiParam(WEBHOOK_ID)
  @ApiOkResponse({ standardSchema: WebhookDeliveryPageDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiPermission('webhook.manage')
  async deliveries(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
    @Param('webhookId') id: string,
    @PageParams() page: PageRequest,
    @Query('filter[status]', { schema: deliveryFilters.status.optional() })
    status?: DeliveryStatus,
    @Query('filter[event]', { schema: deliveryFilters.event.optional() })
    event?: DeliveryEvent,
  ): Promise<z.infer<typeof WebhookDeliveryPageDocument>> {
    const result = await this.listDeliveries.handle({
      actor,
      id,
      page,
      filter: {
        ...(status !== undefined && { status }),
        ...(event !== undefined && { event }),
      },
    });
    return toPagedDocument(req, page, result, toDeliveryResource);
  }

  @Post(':webhookId/test')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Send a webhook a test event',
    description: `Sends a signed \`ping\` event at once (\`{ type: "ping", idempotencyKey, occurredAt, data: { webhookId } }\`) and answers its delivery with the result (\`status\` \`succeeded\` or \`failed\`, \`lastStatusCode\`, \`lastError\`); it is in the log too. Sent as every delivery is (the address checked after resolving the host, the signature, no redirect, the timeout), also to a paused or disabled webhook, once: never retried, and never counted toward turning it off. While the receiver has an attempt in flight, waits after a failure, or its owner has as many in flight as allowed, it is 429 \`rate-limited\` with \`Retry-After\`, and nothing is sent. No body. Recorded as \`webhook.test\`. ${MANAGES}`,
  })
  @ApiParam(WEBHOOK_ID)
  @ApiOkResponse({ standardSchema: WebhookDeliveryDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiTooManyRequestsResponse({
    description:
      '`rate-limited`: the receiver is busy or waits after a failed attempt; `Retry-After` (and `meta.retryAfter`) says when to try again.',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('webhook.manage')
  async test(
    @CurrentActor() actor: Actor,
    @Param('webhookId') id: string,
  ): Promise<z.infer<typeof WebhookDeliveryDocument>> {
    return {
      data: toDeliveryResource(await this.testWebhook.handle({ actor, id })),
    };
  }

  @Post(':webhookId/deliveries/:deliveryId/retry')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Send a failed delivery again',
    description: `Puts a \`failed\` delivery back to \`pending\` and sends it again with a full set of attempts, by the same rules as every delivery; its attempts so far stay counted. Only one of a webhook that is active, still sent its event and owned by whom it was made for. Answers the delivery. No body. Recorded as \`webhook.retry\`. ${MANAGES}`,
  })
  @ApiParam(WEBHOOK_ID)
  @ApiParam({
    name: 'deliveryId',
    description: 'The delivery’s ID (a UUID), of this webhook.',
    schema: { type: 'string' },
  })
  @ApiOkResponse({ standardSchema: WebhookDeliveryDocument })
  @ApiNotFoundResponse(NOT_FOUND)
  @ApiConflictResponse({
    description:
      '`not-retryable` (`meta.reason`): `status` (not `failed`, or being sent again already), `test-event` (send another), `inactive` (paused or disabled: resume it first), `owner-changed` (made for an earlier owner), `audience-changed` (made under another audience limit) or `not-subscribed` (the webhook is no longer sent its event).',
    standardSchema: ErrorDocument,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('webhook.manage')
  async retry(
    @CurrentActor() actor: Actor,
    @Param('webhookId') id: string,
    @Param('deliveryId') deliveryId: string,
  ): Promise<z.infer<typeof WebhookDeliveryDocument>> {
    return {
      data: toDeliveryResource(
        await this.retryDelivery.handle({ actor, id, deliveryId }),
      ),
    };
  }
}
