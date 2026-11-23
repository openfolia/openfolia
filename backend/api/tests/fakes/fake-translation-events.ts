import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type TranslationEvent,
  TranslationEvents,
} from '../../src/translations/core/translation-events.js';
import { fakeOf } from './fake-unit-of-work.js';

/** Translation outbox rows in memory, kept only when their transaction commits. */
export class FakeTranslationEvents extends TranslationEvents {
  readonly events: TranslationEvent[] = [];

  async emit(tx: Transaction, event: TranslationEvent) {
    const transaction = fakeOf(tx);
    if (
      this.events.some((e) => e.topic === event.topic && e.key === event.key)
    ) {
      return false;
    }
    transaction.onCommit(() => this.events.push(event));
    return true;
  }
}
