import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { ContentModule } from '../content/content.module.js';
import { Database } from '../database/database.js';
import { JobQueue } from '../jobs/core/job-queue.js';
import { EmbedSearchTextsJobHandler } from './api/embed-search-texts.handler.js';
import { SearchIndexSweeper } from './api/search-index-sweeper.js';
import { SearchController } from './api/search.controller.js';
import { EmbedSearchTextsAction } from './core/actions/embed-search-texts.action.js';
import { SearchContentAction } from './core/actions/search-content.action.js';
import { ContentSearch, SearchLimits } from './core/content-search.js';
import { Embedder } from './core/embedder.js';
import {
  NoSearchIndexSweep,
  SearchIndexSweep,
} from './core/search-index-sweep.js';
import { SearchTextStore } from './core/search-texts.js';
import { DrizzleSearchTextStore } from './repos/drizzle-search-text-store.js';
import { HttpEmbedder } from './repos/http-embedder.js';
import { InMemoryContentSearch } from './repos/in-memory-content-search.js';
import { NoEmbedder } from './repos/no-embedder.js';
import { PostgresContentSearch } from './repos/postgres-content-search.js';

/**
 * Search (#70, #54): `CCMS_SEARCH_ADAPTER` picks the Postgres index (the
 * default) or the in-memory one; the embedder for semantic search is off
 * (`NoEmbedder`) unless `CCMS_EMBEDDER_URL` names an endpoint
 * (`HttpEmbedder`). Limits (#539): `CCMS_SEARCH_PER_MINUTE` per reader
 * (the action), `CCMS_SEARCH_TIMEOUT_MS` and `CCMS_SEARCH_CONCURRENCY` (the
 * Postgres search). The sweep (#540): `SearchIndexSweeper` on background
 * processes, with `CCMS_SEARCH_SWEEP_AFTER_DAYS` and
 * `CCMS_SEARCH_MODEL_KEPT_DAYS`.
 */
@Module({
  imports: [ContentModule],
  controllers: [SearchController],
  providers: [
    SearchContentAction,
    EmbedSearchTextsAction,
    EmbedSearchTextsJobHandler,
    SearchIndexSweeper,
    {
      provide: SearchIndexSweep,
      inject: [ContentSearch],
      useFactory: (search: ContentSearch): SearchIndexSweep =>
        search instanceof PostgresContentSearch
          ? search
          : new NoSearchIndexSweep(),
    },
    { provide: SearchTextStore, useClass: DrizzleSearchTextStore },
    {
      provide: SearchLimits,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): SearchLimits => ({
        perMinute: config.get('CCMS_SEARCH_PER_MINUTE', { infer: true }),
      }),
    },
    {
      provide: Embedder,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Embedder => {
        const url = config.get('CCMS_EMBEDDER_URL', { infer: true });
        const model = config.get('CCMS_EMBEDDER_MODEL', { infer: true });
        const dimensions = config.get('CCMS_EMBEDDER_DIMENSIONS', {
          infer: true,
        });
        if (!url || !model || dimensions === undefined) return new NoEmbedder();
        return new HttpEmbedder({
          url,
          model,
          dimensions,
          apiKey: config.get('CCMS_EMBEDDER_API_KEY', { infer: true }),
          timeoutMs: config.get('CCMS_EMBEDDER_TIMEOUT_MS', { infer: true }),
        });
      },
    },
    {
      provide: ContentSearch,
      inject: [ConfigService, Database, Embedder, JobQueue],
      useFactory: (
        config: ConfigService<Env, true>,
        database: Database,
        embedder: Embedder,
        jobs: JobQueue,
      ): ContentSearch => {
        const indexesKept = config.get('CCMS_SEARCH_INDEXES', { infer: true });
        if (config.get('CCMS_SEARCH_ADAPTER', { infer: true }) === 'memory') {
          return new InMemoryContentSearch(indexesKept);
        }
        return new PostgresContentSearch(database, embedder, jobs, {
          indexesKept,
          minSimilarity:
            config.get('CCMS_EMBEDDER_MIN_SIMILARITY', { infer: true }) / 100,
          timeoutMs: config.get('CCMS_SEARCH_TIMEOUT_MS', { infer: true }),
          concurrency: config.get('CCMS_SEARCH_CONCURRENCY', { infer: true }),
          sweepAfterDays: config.get('CCMS_SEARCH_SWEEP_AFTER_DAYS', {
            infer: true,
          }),
          modelKeptDays: config.get('CCMS_SEARCH_MODEL_KEPT_DAYS', {
            infer: true,
          }),
        });
      },
    },
  ],
})
export class SearchModule {}
