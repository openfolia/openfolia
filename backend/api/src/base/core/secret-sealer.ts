import type { Transaction } from './unit-of-work.js';

/**
 * Port: seals the secrets the instance stores and opens them again
 * (authenticated encryption under the instance secret key, #470), for a
 * secret the server must use itself (a webhook's signing secret, a header
 * sent with a delivery, a client secret), which a hash would not give back.
 * The adapter is the `secrets` component's (`src/secrets/`); the key is
 * never stored in the database, so a dump of it alone opens nothing.
 */
export abstract class SecretSealer {
  /**
   * False when the instance has no key (generation turned off and none
   * set): sealing and opening throw, and a feature that stores secrets
   * answers 404 `not-configured`.
   */
  abstract readonly available: boolean;

  /**
   * `secret`, encrypted and authenticated, bound to `context` (what it is
   * and whose it is, e.g. `webhook-secret:v1:<webhook ID>`): it opens only
   * for the same context, so a value copied onto another row does not.
   * Never the same text twice.
   */
  abstract seal(secret: string, context: string): string;

  /**
   * The secret sealed in `sealed` for `context`; throws when it cannot be
   * opened (another key, a changed value, another context), never with the
   * value in the message.
   */
  abstract open(sealed: string, context: string): string;
}

/** One sealed value as a component stores it, with the context it was sealed for. */
export interface SealedValue {
  readonly sealed: string;
  readonly context: string;
}

/**
 * Port: one kind of sealed secret the database holds, for the instance
 * key's checks and its rotation. A component that stores sealed secrets
 * implements it in `repos/` and lists it in
 * `src/secrets/sealed-secret-sources.ts`.
 */
export abstract class SealedSecretSource {
  /** What the values are, for messages (e.g. `webhook signing secrets`). */
  abstract readonly name: string;

  /** Up to `limit` of the sealed values stored, for checking that the key opens them. */
  abstract sample(
    tx: Transaction,
    limit: number,
  ): Promise<readonly SealedValue[]>;

  /**
   * Replaces every sealed value stored with `reseal(value)`, in `tx`,
   * holding the rows until it commits; answers how many it replaced.
   * `reseal` answering undefined (the value does not open with the current
   * key, so it was unreadable already) leaves that value as it is. A value
   * that is no longer used (e.g. a webhook's previous secret past its end)
   * may be cleared instead. A throw from `reseal` rejects (and so rolls the
   * transaction back).
   */
  abstract reseal(
    tx: Transaction,
    reseal: (value: SealedValue) => string | undefined,
  ): Promise<number>;
}
