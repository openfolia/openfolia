import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { type JobContext, JobHandler } from '../../jobs/core/job.js';
import { ServerRole } from '../../config/server-role.js';
import { JobQueue } from '../../jobs/core/job-queue.js';
import { EmbedSearchTextsAction } from '../core/actions/embed-search-texts.action.js';
import { Embedder } from '../core/embedder.js';
import {
  EMBED_SEARCH_TEXTS,
  EMBED_SEARCH_TEXTS_KEY,
} from '../core/search-texts.js';

/**
 * Runs `search.embed` jobs (`EmbedSearchTextsAction`), and enqueues one as
 * a consuming process (`all`, `worker`; #527) starts when an embedder is
 * configured, so text indexed before (or while another server's job ended)
 * is embedded too. The `api` role leaves that catch-up to its workers.
 */
@Injectable()
export class EmbedSearchTextsJobHandler
  extends JobHandler<Record<string, never>>
  implements OnApplicationBootstrap
{
  readonly kind = EMBED_SEARCH_TEXTS;
  private readonly logger = new Logger(EmbedSearchTextsJobHandler.name);

  constructor(
    private readonly role: ServerRole,
    private readonly embed: EmbedSearchTextsAction,
    private readonly embedder: Embedder,
    private readonly jobs: JobQueue,
  ) {
    super();
  }

  async run(
    _payload: Record<string, never>,
    context: JobContext,
  ): Promise<void> {
    const embedded = await this.embed.handle({ signal: context.signal });
    if (embedded > 0) this.logger.log(`Embedded ${embedded} search texts.`);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.role.runsBackground || this.embedder.model === undefined) return;
    try {
      await this.jobs.enqueue(
        EMBED_SEARCH_TEXTS,
        {},
        {
          key: EMBED_SEARCH_TEXTS_KEY,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Could not enqueue the embedding of search text: ${(error as Error).name}.`,
      );
    }
  }
}
