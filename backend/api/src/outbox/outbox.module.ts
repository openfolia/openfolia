import { Module } from '@nestjs/common';
import { OutboxStatusController } from './api/outbox-status.controller.js';
import { GetOutboxStatusAction } from './core/actions/get-outbox-status.action.js';
import { OutboxFeed } from './core/outbox-feed.js';
import { DrizzleOutboxFeed } from './repos/drizzle-outbox-feed.js';

/**
 * The outbox read by consumers, each with its own cursor (#252): the
 * notifications' fan-out and webhooks (#42); the change feed reads it
 * directly (`src/changes/`). The rows are written by the components whose
 * changes they report (`change-sets`). `GET /outbox/status` tells which
 * consumers a restore onto another database server holds (#619).
 */
@Module({
  controllers: [OutboxStatusController],
  providers: [
    { provide: OutboxFeed, useClass: DrizzleOutboxFeed },
    GetOutboxStatusAction,
  ],
  exports: [OutboxFeed],
})
export class OutboxModule {}
