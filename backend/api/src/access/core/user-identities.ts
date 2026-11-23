import type { Transaction } from '../../base/core/unit-of-work.js';

/**
 * Port: which person at which identity provider is which user (#37), and
 * the groups the provider put them in at their last sign-in. A user has at
 * most one identity per issuer. Writes run after `AccessAdmin.lock`.
 */
export abstract class UserIdentities {
  /** The user `subject` at `issuer` is; undefined when none is linked yet. */
  abstract userOf(
    tx: Transaction,
    issuer: string,
    subject: string,
  ): Promise<string | undefined>;

  /** Whether `userId` already has an identity at `issuer`. */
  abstract hasIdentityAt(
    tx: Transaction,
    userId: string,
    issuer: string,
  ): Promise<boolean>;

  /**
   * Whether `userId` has an identity at any issuer, a password (#610), or has signed in with a
   * code by email (#634): has a way to sign in of their own already, so `pending` linking by
   * email never joins a provider to them.
   */
  abstract hasAnyIdentity(tx: Transaction, userId: string): Promise<boolean>;

  /** Records, in `tx`, that `userId` signed in with a code by email (#634); once is enough. */
  abstract recordCodeSignIn(tx: Transaction, userId: string): Promise<void>;

  /** The user whose email address is `email`, ignoring case; undefined for none. */
  abstract userWithEmail(
    tx: Transaction,
    email: string,
  ): Promise<string | undefined>;

  /** Links `subject` at `issuer` to `userId`, with its groups, signed in now. */
  abstract link(
    tx: Transaction,
    identity: {
      readonly issuer: string;
      readonly subject: string;
      readonly userId: string;
      readonly groups: readonly string[];
    },
  ): Promise<void>;

  /** Records a sign-in of `subject` at `issuer` (linked already), with its groups now. */
  abstract recordSignIn(
    tx: Transaction,
    issuer: string,
    subject: string,
    groups: readonly string[],
  ): Promise<void>;
}
