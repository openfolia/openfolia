import type { Transaction } from '../../src/base/core/unit-of-work.js';
import { fakeOf, type FakeTransaction } from './fake-unit-of-work.js';

/**
 * The hash locks (`AssetUploads.lockHash`) as Postgres's advisory locks
 * hold them, for fakes that share one: a transaction waits while another
 * holds a hash it asks for, takes it again freely, and lets go of all of
 * them when it ends (#593). Opt-in: a fake without one waits for nothing.
 */
export class FakeHashLocks {
  readonly #held = new Map<string, FakeTransaction>();
  readonly #waiting: (() => void)[] = [];

  /** Holds every one of `hashes` in `tx`, in hash order, until it ends. */
  async lock(tx: Transaction, hashes: readonly string[]): Promise<void> {
    const transaction = fakeOf(tx);
    for (const hash of [...new Set(hashes)].sort()) {
      for (;;) {
        const holder = this.#held.get(hash);
        if (holder === undefined || holder === transaction) break;
        await new Promise<void>((resolve) => this.#waiting.push(resolve));
      }
      if (this.#held.get(hash) === transaction) continue;
      this.#held.set(hash, transaction);
      transaction.onEnd(() => {
        this.#held.delete(hash);
        for (const wake of this.#waiting.splice(0)) wake();
      });
    }
  }

  /** Whether a transaction holds `hash` now. */
  isHeld(hash: string): boolean {
    return this.#held.has(hash);
  }
}
