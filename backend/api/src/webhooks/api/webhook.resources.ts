import { z } from 'zod';
import {
  PageLinks,
  PageMeta,
  pagedDocument,
  resourceObject,
  singleDocument,
} from '../../base/api/json-api.js';
import type {
  ListedWebhook,
  LoggedDelivery,
} from '../core/actions/manage-webhooks.action.js';
import {
  DELIVERY_ERRORS,
  DeliveryEvent,
  DeliveryStatus,
  MAX_URL_LENGTH,
  type Webhook,
  WebhookAudience,
  WebhookDescription,
  WebhookEvent,
} from '../core/webhook.js';
import {
  MAX_HEADER_NAME,
  MAX_HEADERS,
  MAX_HEADERS_SIZE,
} from '../core/webhook-headers.js';

const Time = z.iso.datetime({ offset: true });

export const WebhookResource = resourceObject('Webhook', {
  attributes: z.object({
    url: z.string().describe('Where deliveries are POSTed (https).'),
    description: z.string().nullable(),
    events: z.array(WebhookEvent).describe('The events it is sent, sorted.'),
    maxAudience: WebhookAudience.nullable().describe(
      'Its audience limit: an audience level of the configuration; it is sent only events about content at that level or a less restricted one (within what its owner may read). Null: whatever its owner may read. A level the configuration does not hold matches nothing.',
    ),
    active: z
      .boolean()
      .describe(
        'Whether new events are delivered to it: false while paused (by `PATCH`) or disabled after failing (`disabledReason`).',
      ),
    owner: z
      .object({ kind: z.enum(['user', 'service']), id: z.string() })
      .describe(
        'Who made it, or last pointed it at another URL. It is sent only events about content they may read, judged when each event is made; none once they no longer act.',
      ),
    headers: z
      .array(
        z.object({
          name: z.string(),
          secret: z.boolean(),
          value: z
            .string()
            .nullable()
            .describe(
              'The value sent; null for a secret header, whose value is never shown again (replace it, or remove the header).',
            ),
        }),
      )
      .describe(
        'Custom headers sent with every delivery, in order (an `Authorization` or `X-Api-Key` for a receiver that authenticates requests its own way).',
      ),
    createdAt: Time,
    updatedAt: Time,
    secretRotatedAt: Time.describe('When its current secret was made.'),
  }),
  meta: z.object({
    disabledReason: z
      .enum(['failing'])
      .nullable()
      .describe(
        '`failing`: turned off after deliveries failed for good several times in a row; `PATCH` `active: true` turns it on again. Null otherwise.',
      ),
    disabledAt: Time.nullable(),
    consecutiveFailures: z
      .number()
      .int()
      .describe(
        'Deliveries in a row that failed for good, since the last that succeeded.',
      ),
    previousSecretUntil: Time.nullable().describe(
      'Until when the secret before the last rotation still signs deliveries, beside the current one; null when none does.',
    ),
    lastDelivery: z
      .object({
        id: z.string(),
        event: DeliveryEvent,
        status: DeliveryStatus,
        attempts: z.number().int(),
        lastAttemptAt: Time.nullable(),
        lastStatusCode: z.number().int().nullable(),
        lastError: z.enum(DELIVERY_ERRORS).nullable(),
        createdAt: Time,
      })
      .nullable()
      .optional()
      .describe(
        'Its latest delivery (a test event too), without its body: as in its delivery log. Null when it has had none. Only in `GET /webhooks` and `GET /webhooks/{id}`.',
      ),
  }),
})
  .describe(
    'A webhook subscriber: a URL sent signed events. Never its secret, which is shown only when it is made or rotated, nor the value of a secret custom header.',
  )
  .meta({ id: 'WebhookResource' });

export const WebhookDocument = singleDocument(WebhookResource).meta({
  id: 'WebhookDocument',
});

/** The custom headers' limits (`core/webhook-headers.ts`), as numbers a client checks a form by. */
export const WEBHOOK_HEADER_LIMITS = {
  maxHeaders: MAX_HEADERS,
  maxHeaderName: MAX_HEADER_NAME,
  maxHeadersSize: MAX_HEADERS_SIZE,
} as const;

export const WebhookHeaderLimits = z
  .object({
    maxHeaders: z
      .literal(MAX_HEADERS)
      .describe('The most custom headers a webhook may send.'),
    maxHeaderName: z
      .literal(MAX_HEADER_NAME)
      .describe('The longest header name, in characters.'),
    maxHeadersSize: z
      .literal(MAX_HEADERS_SIZE)
      .describe(
        'The most their names and values may add up to, in characters (ASCII only, so bytes too).',
      ),
  })
  .describe(
    'The limits the custom headers are checked against (`invalid-headers`), so a client can check a form before sending it.',
  )
  .meta({ id: 'WebhookHeaderLimits' });

/** `GET /webhooks`: a page of subscribers, and the custom headers' limits. */
export const WebhookPageDocument = z
  .object({
    data: z.array(WebhookResource),
    meta: z.object({ page: PageMeta, headerLimits: WebhookHeaderLimits }),
    links: PageLinks,
  })
  .meta({ id: 'WebhookPageDocument' });

/** `POST /webhooks` and `POST /webhooks/{id}/secret`: the subscriber, and its secret, this once. */
export const WebhookWithSecretDocument = z
  .object({
    data: WebhookResource,
    meta: z.object({
      secret: z
        .string()
        .describe(
          'The signing secret (`whsec_` and 64 hex digits). Shown only in this answer: store it now; it cannot be read again.',
        ),
    }),
  })
  .meta({ id: 'WebhookWithSecretDocument' });

export function toWebhookResource(
  webhook: Webhook | ListedWebhook,
): z.infer<typeof WebhookResource> {
  const last = 'lastDelivery' in webhook ? webhook.lastDelivery : undefined;
  return {
    type: 'Webhook',
    id: webhook.id,
    attributes: {
      url: webhook.url,
      description: webhook.description,
      events: [...webhook.events],
      maxAudience: webhook.maxAudience,
      active: webhook.active,
      owner: { kind: webhook.owner.kind, id: webhook.owner.id },
      headers: webhook.headers.map((h) => ({
        name: h.name,
        secret: h.secret,
        // Never a secret one's, whatever was handed in.
        value: h.secret ? null : h.value,
      })),
      createdAt: webhook.createdAt.toISOString(),
      updatedAt: webhook.updatedAt.toISOString(),
      secretRotatedAt: webhook.secretRotatedAt.toISOString(),
    },
    meta: {
      disabledReason: webhook.disabledReason,
      disabledAt: webhook.disabledAt?.toISOString() ?? null,
      consecutiveFailures: webhook.consecutiveFailures,
      previousSecretUntil: webhook.previousSecretUntil?.toISOString() ?? null,
      ...(last !== undefined && {
        lastDelivery: last && {
          id: last.id,
          event: last.event,
          status: last.status,
          attempts: last.attempts,
          lastAttemptAt: last.lastAttemptAt?.toISOString() ?? null,
          lastStatusCode: last.lastStatusCode,
          lastError: last.lastError,
          createdAt: last.createdAt.toISOString(),
        },
      }),
    },
  };
}

export const WebhookDeliveryResource = resourceObject('WebhookDelivery', {
  attributes: z.object({
    event: DeliveryEvent.describe(
      'The event sent; `ping` for a test event (`POST /webhooks/{id}/test`).',
    ),
    idempotencyKey: z
      .string()
      .describe(
        'Sent as `Idempotency-Key`: the same event always has the same key.',
      ),
    payload: z
      .record(z.string(), z.unknown())
      .nullable()
      .describe(
        'The JSON body sent (the same on every attempt). Null for a reader who may not see what the owner it was made for may: only that owner, or a reader whose `content.read` restricts nothing (for `translation.imported` also `content.read.draft` and `translation.manage`), sees it.',
      ),
    status: DeliveryStatus.describe(
      '`pending` (an attempt follows), `succeeded` (a 2xx answer; never sent again), `failed` (every attempt failed, or the address was refused; `POST …/deliveries/{id}/retry` sends it again), `skipped` (not sent: the subscriber was paused, disabled or no longer subscribed to the event).',
    ),
    attempts: z
      .number()
      .int()
      .describe('Attempts made so far, those of every retry by hand too.'),
    lastAttemptAt: Time.nullable(),
    lastStatusCode: z
      .number()
      .int()
      .nullable()
      .describe(
        'The receiver’s status code at the last attempt, when it answered.',
      ),
    lastError: z
      .enum(DELIVERY_ERRORS)
      .nullable()
      .describe(
        'Why the last attempt failed: `http-status` (not 2xx; redirects are not followed), `timeout`, `connection`, `blocked-address` (the host resolved to a non-public address), `blocked-url`, `secret-unreadable` (the server’s key changed).',
      ),
    deliveredAt: Time.nullable(),
    sentHeaders: z
      .array(z.string())
      .nullable()
      .describe(
        'The names of the headers the last attempt sent (the server’s and the webhook’s custom ones), never their values; null before an attempt sent anything.',
      ),
    createdAt: Time,
  }),
  relationships: z.object({
    webhook: z.object({
      data: z.object({ type: z.literal('Webhook'), id: z.string() }),
    }),
  }),
})
  .describe('One event sent to one subscriber, with its attempts.')
  .meta({ id: 'WebhookDeliveryResource' });

export const WebhookDeliveryPageDocument = pagedDocument(
  WebhookDeliveryResource,
).meta({ id: 'WebhookDeliveryPageDocument' });

export function toDeliveryResource(
  delivery: LoggedDelivery,
): z.infer<typeof WebhookDeliveryResource> {
  let payload: Record<string, unknown> | null =
    delivery.body === null ? null : {};
  if (delivery.body !== null)
    try {
      const parsed: unknown = JSON.parse(delivery.body);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Stored by the server as JSON; never anything else.
    }
  return {
    type: 'WebhookDelivery',
    id: delivery.id,
    attributes: {
      event: delivery.event,
      idempotencyKey: delivery.idempotencyKey,
      payload,
      status: delivery.status,
      attempts: delivery.attempts,
      lastAttemptAt: delivery.lastAttemptAt?.toISOString() ?? null,
      lastStatusCode: delivery.lastStatusCode,
      lastError: delivery.lastError,
      deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
      sentHeaders: delivery.sentHeaders && [...delivery.sentHeaders],
      createdAt: delivery.createdAt.toISOString(),
    },
    relationships: {
      webhook: { data: { type: 'Webhook', id: delivery.webhookId } },
    },
  };
}

const Url = z
  .string()
  .min(1)
  .max(MAX_URL_LENGTH)
  .describe(
    'An absolute `https:` URL (`http:` only where the server allows it for local testing), with no user name, password or fragment, whose host is not a private, loopback or link-local address. Checked again, after resolving the host, on every delivery.',
  );

const MaxAudience = WebhookAudience.nullable().describe(
  'Its audience limit: an audience level of the configuration (`GET /config`, `audiences`); events about content above it are not sent. Null: none (whatever its owner may read).',
);

const Events = z
  .array(WebhookEvent)
  .min(1)
  .max(20)
  .describe('The events to send it; at least one.');

const Headers = z
  .array(
    z.strictObject({
      name: z
        .string()
        .max(200)
        .describe(
          'An RFC 9110 token, compared without case; not one the server sets or that would break the delivery: `Host`, `Content-Length`, `Content-Type`, `Content-Encoding`, `Transfer-Encoding`, `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Upgrade`, `Expect`, `Cookie`, `User-Agent`, `Idempotency-Key`, `Proxy-*` and `X-Ccms-*`.',
        ),
      value: z
        .string()
        .max(10_000)
        .optional()
        .describe(
          'Visible ASCII, spaces and tabs inside (never a line break); leading and trailing white space is dropped. Left out of a secret header that exists already: its stored value stays (not when the URL changes).',
        ),
      secret: z
        .boolean()
        .optional()
        .describe(
          'Stored sealed and never shown again (`value` null in every answer). Default false.',
        ),
    }),
  )
  .max(100)
  .describe(
    'Custom headers sent with every delivery (all of them: they replace those stored); at most 20, names and values together at most 8,192 characters. A 422 names each problem with its own `code` and `source.pointer`.',
  );

/** `POST /webhooks`. */
export const CreateWebhookDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Webhook'),
      attributes: z.strictObject({
        url: Url,
        events: Events,
        description: WebhookDescription.nullable()
          .optional()
          .describe('What it is for, 1 to 500 characters; null for none.'),
        maxAudience: MaxAudience.optional(),
        headers: Headers.optional(),
      }),
    }),
  })
  .meta({ id: 'CreateWebhookDocument' });
export type CreateWebhookDocument = z.output<typeof CreateWebhookDocument>;

/** `PATCH /webhooks/{id}`. */
export const UpdateWebhookDocument = z
  .strictObject({
    data: z.strictObject({
      type: z.literal('Webhook'),
      id: z.string().describe('The webhook’s ID, as in the path.'),
      attributes: z
        .strictObject({
          url: Url.optional(),
          events: Events.optional(),
          description: WebhookDescription.nullable()
            .optional()
            .describe('Null removes it.'),
          maxAudience: MaxAudience.optional(),
          headers: Headers.optional(),
          active: z
            .boolean()
            .optional()
            .describe(
              '`false` pauses it (nothing new is delivered, and waiting deliveries are skipped); `true` resumes it, also after it was disabled for failing (the failures counted start again at 0).',
            ),
        })
        .optional(),
    }),
  })
  .meta({ id: 'UpdateWebhookDocument' });
export type UpdateWebhookDocument = z.output<typeof UpdateWebhookDocument>;

export const deliveryFilters = {
  status: DeliveryStatus,
  event: DeliveryEvent,
};

/** `POST /webhooks/{id}/test` and `POST …/deliveries/{id}/retry`: the delivery. */
export const WebhookDeliveryDocument = singleDocument(
  WebhookDeliveryResource,
).meta({ id: 'WebhookDeliveryDocument' });
