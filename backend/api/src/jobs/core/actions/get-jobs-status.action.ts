import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import type { Permission } from '../../../access/core/permissions.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  JobsOverview,
  type JobsStatus,
  lagSeconds,
  levelOf,
} from '../job-consumers.js';

/** Who reads where the job queue stands: administrators (`admin.roles`), as for the storage used. */
export const READ_JOBS_STATUS = 'admin.roles' satisfies Permission;

export interface JobsStatusReport extends JobsStatus {
  readonly lagSeconds: number;
  readonly level: 'ok' | 'warning';
}

/**
 * Whether background work is taken (#527): the consuming processes heard
 * from, when one last consumed, the jobs due and running, and a warning
 * when jobs wait while nothing consumes (`levelOf`). It reads the queue
 * as a whole: kinds and counts only, never a job's payload.
 */
@Injectable()
export class GetJobsStatusAction extends ActorAction<
  { actor: Actor },
  JobsStatusReport
> {
  readonly policy = READ_JOBS_STATUS;

  constructor(private readonly overview: JobsOverview) {
    super();
  }

  protected async run(): Promise<JobsStatusReport> {
    const status = await this.overview.status();
    return {
      ...status,
      lagSeconds: lagSeconds(status),
      level: levelOf(status),
    };
  }
}
