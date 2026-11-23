import { z } from 'zod';
import { defineJob } from '../../jobs/core/job.js';
import { isMessageId } from './mail.js';

/**
 * Sends one queued email (`mail_messages`): 7 attempts, the retries 30 s apart at first and
 * doubled each time with jitter (about 30 s, 1, 2, 4, 8 and 16 minutes: some half an hour in
 * all), then it has failed for good (`mail.failed`). An attempt runs at most two minutes (the
 * connection's own timeouts are shorter). Two at once per server. The payload names the
 * message only: what it says is sealed in its row.
 */
export const SEND_MAIL = defineJob({
  name: 'mail.send',
  payload: z.strictObject({
    messageId: z.string().refine(isMessageId, 'not a message ID'),
  }),
  retryLimit: 6,
  retryDelaySeconds: 30,
  timeoutSeconds: 120,
  concurrency: 2,
  // A day past the retries: a job the queue drops unsent leaves its row, removed as stale.
  retentionSeconds: 86_400,
});
export type SendMailPayload = z.infer<typeof SEND_MAIL.payload>;
