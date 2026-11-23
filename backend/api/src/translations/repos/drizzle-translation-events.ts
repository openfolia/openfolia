import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { outbox } from '../../change-sets/repos/outbox.tables.js';
import { drizzleOf } from '../../database/drizzle-unit-of-work.js';
import {
  type TranslationEvent,
  TranslationEvents,
} from '../core/translation-events.js';

/** `TranslationEvents` over the `outbox` table (keyed per topic). */
@Injectable()
export class DrizzleTranslationEvents extends TranslationEvents {
  async emit(tx: Transaction, event: TranslationEvent): Promise<boolean> {
    const inserted = await drizzleOf(tx)
      .insert(outbox)
      .values({ topic: event.topic, key: event.key, payload: event.payload })
      .onConflictDoNothing({ target: [outbox.topic, outbox.key] })
      .returning({ id: outbox.id });
    return inserted.length > 0;
  }
}
