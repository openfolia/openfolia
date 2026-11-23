import { Module } from '@nestjs/common';
import { ChunksModule } from '../chunks/chunks.module.js';
import { ContentModule } from '../content/content.module.js';
import { ReleasesModule } from '../releases/releases.module.js';
import { WebhookEventBuilder } from '../webhooks/core/webhook-events.js';
import { ChangesController } from './api/changes.controller.js';
import { ReadChangesAction } from './core/actions/read-changes.action.js';
import { ChangeFeedSource } from './core/change-feed-source.js';
import { ChunkStates, ReleasedChunkStates } from './core/chunk-states.js';
import { FeedScopes } from './core/feed-scopes.js';
import { DrizzleChangeFeedSource } from './repos/drizzle-change-feed-source.js';
import { DrizzleFeedScopes } from './repos/drizzle-feed-scopes.js';

/**
 * The change feed (#43): `GET /changes`, the outbox's releases,
 * withdrawals and deprecations as webhook events (#42, built by the same
 * `WebhookEventBuilder`) and chunk events (#52), cursor-paged and scoped
 * to the reader.
 */
@Module({
  imports: [ChunksModule, ContentModule, ReleasesModule],
  controllers: [ChangesController],
  providers: [
    ReadChangesAction,
    WebhookEventBuilder,
    { provide: ChangeFeedSource, useClass: DrizzleChangeFeedSource },
    { provide: FeedScopes, useClass: DrizzleFeedScopes },
    { provide: ChunkStates, useClass: ReleasedChunkStates },
  ],
})
export class ChangesModule {}
