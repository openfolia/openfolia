import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import type { OutboxStatusReport } from '../core/actions/get-outbox-status.action.js';

export const OutboxStatusResource = resourceObject('OutboxStatus', {
  attributes: z.object({
    blockedConsumers: z
      .array(z.string())
      .max(100)
      .describe(
        'The outbox consumers held after a restore onto another database server, by name (`notifications`, `webhooks`, `change-feed`): they deliver nothing until the operator runs the recipe in `backend/api/README.md`, "Outbox", "After a restore". Empty when all read on.',
      ),
  }),
  meta: z.object({
    level: z
      .enum(['ok', 'error'])
      .describe('`error` when any consumer is held.'),
  }),
})
  .describe('`id` is always `outbox`.')
  .meta({ id: 'OutboxStatusResource' });

export const OutboxStatusDocument = singleDocument(OutboxStatusResource).meta({
  id: 'OutboxStatusDocument',
});

export function toOutboxStatusDocument(
  report: OutboxStatusReport,
): z.infer<typeof OutboxStatusDocument> {
  return {
    data: {
      type: 'OutboxStatus',
      id: 'outbox',
      attributes: { blockedConsumers: [...report.blocked] },
      meta: { level: report.level },
    },
  };
}
