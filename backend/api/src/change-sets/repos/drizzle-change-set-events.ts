import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type ChangeSetEvent,
  ChangeSetEvents,
} from '../core/change-set-events.js';
import { outbox } from './outbox.tables.js';

/** `ChangeSetEvents` over the `outbox` table. */
@Injectable()
export class DrizzleChangeSetEvents extends ChangeSetEvents {
  async emit(tx: Transaction, event: ChangeSetEvent): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(outbox)
      .values({ topic: event.topic, key: event.key, payload: event.payload })
      .onConflictDoNothing({ target: [outbox.topic, outbox.key] })
      .returning({ id: outbox.id });
    return inserted.length > 0;
  }
}
