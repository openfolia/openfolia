import { Controller, Get } from '@nestjs/common';
import { DeliveryApi } from '../../base/api/delivery.decorator.js';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ErrorDocument } from '../../base/api/json-api.js';
import { UnavailableError } from '../../base/core/errors.js';
import { Public } from '../../base/api/public.decorator.js';
import { CheckHealthAction } from '../core/actions/check-health.action.js';

/** What `Retry-After` tells a client of a 503 from `/health/ready`. */
const NOT_READY_RETRY_SECONDS = 5;

export const Health = z
  .object({
    status: z
      .enum(['ok', 'degraded'])
      .describe('`degraded` when a dependency is unavailable'),
    database: z.enum(['ok', 'unavailable']),
    pool: z
      .enum(['ok', 'saturated'])
      .describe('`saturated` when queries wait for a free database connection'),
    blobs: z
      .enum(['ok', 'unavailable'])
      .describe(
        '`unavailable` when the blob store (images, files) does not answer',
      ),
  })
  .meta({ id: 'Health' });

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly checkHealth: CheckHealthAction) {}

  @Public()
  @Get()
  @DeliveryApi()
  @ApiOperation({
    summary: 'Health check',
    description:
      'Liveness, for orchestrators deciding whether to restart the instance; needs no token. Always 200 while the server runs (content and PDF routes work without the database); `database` is `unavailable` when it does not answer within 2 seconds. A load balancer choosing instances to route to uses `/health/ready`.',
  })
  @ApiOkResponse({ standardSchema: Health })
  check(): Promise<z.infer<typeof Health>> {
    return this.checkHealth.handle();
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness check',
    description:
      'Whether this instance should receive traffic, for load balancers; needs no token. 200 when the database and the blob store answer (each within 2 seconds) and queries do not wait for a connection, a JSON:API 503 error (`database-unavailable`, `blob-store-unavailable` or `database-saturated`) otherwise. Unlike `/health`, a failing answer is no reason to restart the instance.',
  })
  @ApiOkResponse({ standardSchema: Health })
  @ApiResponse({
    status: 503,
    description:
      'Not ready: the database is unavailable (`database-unavailable`), the blob store is (`blob-store-unavailable`) or the database pool is exhausted (`database-saturated`). A JSON:API error with `Retry-After`; the reason stays in the log.',
    standardSchema: ErrorDocument,
  })
  async ready(): Promise<z.infer<typeof Health>> {
    const report = await this.checkHealth.handle();
    if (report.database !== 'ok') {
      throw new UnavailableError(
        'database-unavailable',
        'The database does not answer.',
        NOT_READY_RETRY_SECONDS,
      );
    }
    if (report.blobs !== 'ok') {
      throw new UnavailableError(
        'blob-store-unavailable',
        'The blob store does not answer.',
        NOT_READY_RETRY_SECONDS,
      );
    }
    if (report.pool !== 'ok') {
      throw new UnavailableError(
        'database-saturated',
        'Every database connection is in use.',
        NOT_READY_RETRY_SECONDS,
      );
    }
    return report;
  }
}
