/** An attempt counted before its password was checked, to take back when it was right. */
export interface PasswordAttempt {
  readonly keyHash: string;
  /** The window it was counted in: taking it back never touches a later one. */
  readonly windowStart: Date;
}

/**
 * Port: the lockout per account (#610). Every password check for an account (a sign-in with
 * its address, a change of one's own password, a second factor's code, #611) and every "Forgot password" for an address
 * counts toward one total per key, at most `CCMS_PASSWORD_FAILURES_MAX` per
 * `CCMS_PASSWORD_FAILURES_WINDOW_MS`. Counted before the check, in one step with the limit's
 * test, so attempts at once cannot slip past it; a right password is taken back. Kept alike
 * for an address nobody has and one somebody has, so the lockout says nothing about which.
 */
export abstract class PasswordAttempts {
  /**
   * Counts an attempt for `key` unless it is past the limit: the attempt and how many more its
   * window allows after it (`Infinity` without a limit; #634 revokes a code at 0), or the
   * seconds until it may try again.
   */
  abstract reserve(
    key: string,
    options?: {
      /**
       * An upper bound on the limit, whatever the settings say (also 0: no limit): the smaller
       * of the two holds. For a second factor's codes (#611), six digits that must never be
       * guessed without end.
       */
      readonly atMost?: number;
    },
  ): Promise<
    { attempt: PasswordAttempt; remaining: number } | { retryAfter: number }
  >;

  /** Takes back `attempt` (its password was right), in its own window only. */
  abstract forgive(attempt: PasswordAttempt): Promise<void>;
}
