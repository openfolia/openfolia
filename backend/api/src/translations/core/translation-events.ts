import type { Transaction } from '../../base/core/unit-of-work.js';

/** A translation import's outbox row (#51). */
export interface TranslationEvent {
  /** `translation.imported`, keyed by the import's ID: written once per import. */
  readonly topic: 'translation.imported';
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Port: the outbox rows of translation imports, written in the transaction
 * that records the import's commit and audit event, for webhooks (#42) and
 * notifications (#252) to read in order.
 */
export abstract class TranslationEvents {
  /** Writes `event` inside `tx`; false (nothing written) when its key is in use. */
  abstract emit(tx: Transaction, event: TranslationEvent): Promise<boolean>;
}
