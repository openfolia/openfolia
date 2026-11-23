import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { outbox } from '../../change-sets/repos/outbox.tables.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import { type ReleaseEvent, ReleaseEvents } from '../core/release-events.js';

/** `ReleaseEvents` over the `outbox` table (keyed per topic). */
@Injectable()
export class DrizzleReleaseEvents extends ReleaseEvents {
  async emit(tx: Transaction, event: ReleaseEvent): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(outbox)
      .values({ topic: event.topic, key: event.key, payload: event.payload })
      .onConflictDoNothing({ target: [outbox.topic, outbox.key] })
      .returning({ id: outbox.id });
    return inserted.length > 0;
  }
}
