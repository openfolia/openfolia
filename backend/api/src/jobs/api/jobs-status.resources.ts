import { z } from 'zod';
import { resourceObject, singleDocument } from '../../base/api/json-api.js';
import type { JobsStatusReport } from '../core/actions/get-jobs-status.action.js';
import { CONSUMER_LIVE_SECONDS, STALL_SECONDS } from '../core/job-consumers.js';

const Count = z.number().int().min(0);
const Time = z.iso.datetime({ offset: true });

export const JobsStatusResource = resourceObject('JobsStatus', {
  attributes: z.object({
    consumers: Count.describe(
      `Processes consuming jobs (\`CCMS_ROLE\` \`worker\` or \`all\`) heard from in the last ${CONSUMER_LIVE_SECONDS} seconds.`,
    ),
    lastConsumedAt: Time.nullable().describe(
      'When any of them last claimed or ran a job; null when none has (for a day).',
    ),
    ready: Count.describe('Jobs due and waiting to be claimed.'),
    running: Count.describe('Attempts running now.'),
    oldestReadyAt: Time.nullable().describe(
      'Since when the longest-waiting due job is due; null when none waits.',
    ),
  }),
  meta: z.object({
    checkedAt: Time.describe('The database’s time of the reading.'),
    lagSeconds: Count.describe(
      'How long the longest-waiting due job has waited, in seconds (0 when none waits).',
    ),
    level: z
      .enum(['ok', 'warning'])
      .describe(
        `\`warning\` when due jobs have waited ${STALL_SECONDS / 60} minutes or more and no consumer has claimed or run one for as long: no worker takes them.`,
      ),
    stallSeconds: Count.describe(
      'The wait from which `level` can be `warning`.',
    ),
  }),
})
  .describe('`id` is always `jobs`.')
  .meta({ id: 'JobsStatusResource' });

export const JobsStatusDocument = singleDocument(JobsStatusResource).meta({
  id: 'JobsStatusDocument',
});

export function toJobsStatusDocument(
  report: JobsStatusReport,
): z.infer<typeof JobsStatusDocument> {
  return {
    data: {
      type: 'JobsStatus',
      id: 'jobs',
      attributes: {
        consumers: report.consumers,
        lastConsumedAt: report.lastConsumedAt?.toISOString() ?? null,
        ready: report.ready,
        running: report.running,
        oldestReadyAt: report.oldestReadyAt?.toISOString() ?? null,
      },
      meta: {
        checkedAt: report.checkedAt.toISOString(),
        lagSeconds: report.lagSeconds,
        level: report.level,
        stallSeconds: STALL_SECONDS,
      },
    },
  };
}
