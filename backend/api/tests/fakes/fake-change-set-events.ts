import type { Transaction } from '../../src/base/core/unit-of-work.js';
import {
  type ChangeSetEvent,
  ChangeSetEvents,
} from '../../src/change-sets/core/change-set-events.js';
import { fakeOf } from './fake-unit-of-work.js';

/** Outbox rows in memory, kept only when their transaction commits. */
export class FakeChangeSetEvents extends ChangeSetEvents {
  readonly events: ChangeSetEvent[] = [];

  async emit(tx: Transaction, event: ChangeSetEvent) {
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
