import { z } from 'zod';
import { defineJob } from '../../jobs/core/job.js';

/**
 * Applying an import (`POST /imports/:id/apply`): its job names the
 * import, nothing else. One attempt may take up to an hour (a large
 * import uploads its files and writes several save points); a failed one
 * is retried, and its steps are idempotent (`RunImportAction`).
 */
export const APPLY_IMPORT = defineJob({
  name: 'import.apply',
  payload: z.strictObject({ importId: z.uuid() }),
  retryLimit: 3,
  retryDelaySeconds: 30,
  timeoutSeconds: 60 * 60,
  concurrency: 1,
});
export type ApplyImportPayload = z.infer<typeof APPLY_IMPORT.payload>;
