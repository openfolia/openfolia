import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../audit/core/audit-log.js';
import {
  BOUNDED,
  runContended,
  type Transaction,
  UnitOfWork,
} from '../../base/core/unit-of-work.js';
import type { Actor } from './actor.js';
import type { SessionLimits } from './session-policy.js';
import {
  type AllowedSignIns,
  allowedSignIns,
  type SignInRule,
  SignInRules,
  SignInSetup,
  sessionLimitOf,
} from './sign-in-rules.js';

/** How much of what is no longer allowed was ended. */
export interface EndedSignIns {
  readonly sessions: number;
  readonly secondSteps: number;
  readonly links: number;
  readonly emailCodes: number;
}

/** Port: ends, for everyone at once, what the rule about signing in refuses (#378). */
export abstract class RefusedSignIns {
  /**
   * Ends, in `tx`: the sessions past `limits` at `now`, and with `allowed` a list, the sessions and
   * the open second steps begun any other way, the links to set a password (but the break-glass
   * account's) and every code by email. Takes the links, then the codes, the steps and the
   * sessions, as `WaysIn` does.
   */
  abstract end(
    tx: Transaction,
    refused: {
      readonly allowed: AllowedSignIns;
      /** Null: as long as they last. */
      readonly limits: SessionLimits | null;
      readonly now: Date;
    },
  ): Promise<EndedSignIns>;

  /**
   * Holds the person `userId` until `tx` ends, as a sign-in does (`WaysIn.holdPerson`): before
   * the settings are locked, which a sign-in waits for while it holds its person.
   */
  abstract hold(tx: Transaction, userId: string): Promise<void>;

  /**
   * Ends, in `tx` (their person held), every password way in of `userId`: their links to set one,
   * their open second steps begun with it and their sessions begun with it, but the one of
   * `keepSessionHash`. For the break-glass account, whose ways in `end` leaves.
   */
  abstract endPasswordsOf(
    tx: Transaction,
    userId: string,
    keepSessionHash?: string,
  ): Promise<EndedSignIns>;
}

/** How long a session lasts by `rule`, on a server set up as `setup`. */
export function sessionLimitsOf(
  rule: SignInRule,
  setup: SignInSetup,
): SessionLimits {
  return {
    idleMs:
      sessionLimitOf(rule.sessionIdleMinutes, setup.sessionIdleMinutes) *
      60_000,
    maxMs:
      sessionLimitOf(rule.sessionMaxHours, setup.sessionMaxHours) * 3_600_000,
  };
}

/**
 * Ends what the stored rule refuses now (#378), in a transaction of its own, recorded as
 * `settings.sign-ins-ended` when there was anything: before a change of the rule, so nothing it
 * refused comes back with it, and after one, so nothing it refuses stays. Apart from the change's
 * transaction, as a sign-in holds its person and waits for the rule, which that one holds. Nothing
 * rests on it while the rule stands: every request and every sign-in asks the rule itself.
 *
 * The rule is read before the transaction. Read too late, a newer one has its own run, so it ends
 * at most what a newer one allows again (one more sign-in). Too little would matter only before a
 * change that allows more: that one is made only if the settings are still those this read
 * (`UpdateInstallationSettingsAction`).
 */
@Injectable()
export class EndRefusedSignIns {
  now: () => number = Date.now;

  constructor(
    private readonly rules: SignInRules,
    private readonly setup: SignInSetup,
    private readonly refused: RefusedSignIns,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {}

  async run(actor: Actor): Promise<void> {
    const rule = await this.rules.read();
    await runContended(
      this.unit,
      async (tx) => {
        const ended = await this.refused.end(tx, {
          allowed: allowedSignIns(rule, this.setup.offered),
          limits: sessionLimitsOf(rule, this.setup),
          now: new Date(this.now()),
        });
        await recordEnded(this.auditLog, tx, actor, ended);
      },
      BOUNDED,
    );
  }
}

/** Records what was ended (`settings.sign-ins-ended`), when there was anything: counts only. */
export async function recordEnded(
  auditLog: AuditLog,
  tx: Transaction,
  actor: Actor,
  ended: EndedSignIns,
): Promise<void> {
  if (Object.values(ended).every((count) => count === 0)) return;
  await auditLog.record(tx, actor, {
    action: 'settings.sign-ins-ended',
    subject: { type: 'settings', id: 'installation' },
    data: { ...ended },
  });
}
