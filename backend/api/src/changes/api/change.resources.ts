import { z } from 'zod';
import { resourceObject } from '../../base/api/json-api.js';
import {
  FEED_EVENTS,
  type FeedEvent,
} from '../core/actions/read-changes.action.js';

export const ChangeResource = resourceObject('Change', {
  attributes: z.object({
    event: z
      .enum(FEED_EVENTS)
      .describe(
        'What happened. The webhook events (`manual.released`, `module.released`, `release.withdrawn`, `module.deprecated`, `manual.deprecated`) have the shapes and idempotency keys webhook deliveries have; `chunk.upserted` and `chunk.removed` tell a retrieval index what to store and what to drop, per chunk of `GET /chunks`.',
      ),
    occurredAt: z
      .string()
      .describe(
        'When the release, withdrawal or deprecation was recorded (ISO 8601); for a snapshot or a change of your scope, when it was told.',
      ),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        'IDs and what changed, never content. `chunk.upserted`: `chunkId` (`GET /chunks`’s `id`), `moduleId`, `lang`, `blockId` (an FAQ entry’s, else null), `contentHash` (the chunk’s, as `GET /chunks` gives it: re-embed only when it differs from yours) and `release` (`releaseId`, `product`, `revision`, `tag`, `commit`: read the chunk at `?ref=<commit>`). `chunk.removed`: `chunkId`, `moduleId`, `lang`, `blockId`, `reason` (`deprecated`: with no replacement; `withdrawn`: its release was withdrawn; `gone`: deleted, or no longer yours to read, never told which) and `release` (the release now standing, or null). The webhook events: as their deliveries’ `data`.',
      ),
  }),
}).meta({ id: 'ChangeResource' });

export const ChangePageDocument = z
  .object({
    data: z.array(ChangeResource),
    meta: z.object({
      page: z.object({
        size: z.number().int().describe('The most events asked for.'),
        cursor: z
          .string()
          .describe(
            'Where the next page starts (opaque): pass it as `page[cursor]`. Keep it with what you stored: it is how you resume after a restart.',
          ),
      }),
      upToDate: z
        .boolean()
        .describe(
          'Nothing more to tell right now: poll again later with `meta.page.cursor` (or when a webhook arrives).',
        ),
    }),
    links: z.object({
      self: z.string(),
      next: z
        .string()
        .describe(
          'This route with the next cursor: always there, a feed never ends.',
        ),
    }),
  })
  .meta({ id: 'ChangePageDocument' });

export function toChangeResource(
  event: FeedEvent,
): z.infer<typeof ChangeResource> {
  return {
    type: 'Change',
    id: event.idempotencyKey,
    attributes: {
      event: event.type,
      occurredAt: event.occurredAt.toISOString(),
      data: { ...event.data },
    },
  };
}
