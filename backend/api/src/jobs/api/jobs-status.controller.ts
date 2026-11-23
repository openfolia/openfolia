import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { ApiPermission } from '../../access/api/api-permission.decorator.js';
import type { Actor } from '../../access/core/actor.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import {
  GetJobsStatusAction,
  READ_JOBS_STATUS,
} from '../core/actions/get-jobs-status.action.js';
import {
  JobsStatusDocument,
  toJobsStatusDocument,
} from './jobs-status.resources.js';

/** `GET /jobs/status` (#527): whether background work is taken, for administrators. */
@ApiTags('jobs')
@Controller('jobs')
@JsonApi()
export class JobsStatusController {
  constructor(private readonly getStatus: GetJobsStatusAction) {}

  @Get('status')
  @ApiOperation({
    summary: 'Background work',
    description: `Whether the background jobs (release planning and files, imports, webhook deliveries, …) are taken: the processes consuming them (\`CCMS_ROLE\` \`worker\` or \`all\`) heard from in the last minute, when one last consumed, the jobs due and running, and how long the longest-waiting one waited. \`meta.level\` is \`warning\` when jobs have waited five minutes while nothing consumed: no worker takes them. Counts only, never a job's content. Needs the \`${READ_JOBS_STATUS}\` permission.`,
  })
  @ApiOkResponse({ standardSchema: JobsStatusDocument })
  @ApiPermission(READ_JOBS_STATUS)
  async status(
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof JobsStatusDocument>> {
    return toJobsStatusDocument(await this.getStatus.handle({ actor }));
  }
}
