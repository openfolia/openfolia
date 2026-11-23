import { Injectable } from '@nestjs/common';
import { type JobContext, JobHandler } from '../../jobs/core/job.js';
import {
  FailImportAction,
  RunImportAction,
} from '../core/actions/run-import.action.js';
import { APPLY_IMPORT, type ApplyImportPayload } from '../core/import-job.js';

/** Runs `import.apply` jobs: `RunImportAction`, and `FailImportAction` once one failed for good. */
@Injectable()
export class ApplyImportJobHandler extends JobHandler<ApplyImportPayload> {
  readonly kind = APPLY_IMPORT;

  constructor(
    private readonly runImport: RunImportAction,
    private readonly failImport: FailImportAction,
  ) {
    super();
  }

  run(payload: ApplyImportPayload, context: JobContext): Promise<void> {
    return this.runImport.handle({
      importId: payload.importId,
      signal: context.signal,
    });
  }

  override failed(payload: ApplyImportPayload): Promise<void> {
    return this.failImport.handle({ importId: payload.importId });
  }
}
