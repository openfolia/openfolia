import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type ReleaseEvent,
  ReleaseEvents,
} from '../../src/releases/core/release-events.js';
import { fakeOf } from './fake-unit-of-work.js';

/** Release outbox rows in memory, kept only when their transaction commits. */
export class FakeReleaseEvents extends ReleaseEvents {
  readonly events: ReleaseEvent[] = [];

  async emit(tx: Transaction, event: ReleaseEvent) {
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
