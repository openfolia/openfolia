import { Injectable } from '@nestjs/common';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { EmailCodes } from './email-codes.js';
import { PendingSignIns } from './pending-sign-ins.js';
import { SessionStore } from './sessions.js';
import { SignInLinks } from './sign-in-links.js';

/**
 * Ends a person's ways in (#645), in the transaction of the change that calls for it, so a new
 * way in never misses one: their sessions, the links to set a password (`SignInLinks`), the
 * open code by email (`EmailCodes`) and the sign-ins whose second step is open (`PendingSignIns`,
 * #611). A way in added later is ended here too. It holds the person
 * first, until the change commits (#650, `holdPerson`), so a request for a code under way
 * (`EmailCodes.hold`) either finishes first and its code is ended, or reads the person after the
 * change; and every such change takes the person, their links, then their code, in that order.
 */
@Injectable()
export class WaysIn {
  constructor(
    private readonly sessions: SessionStore,
    private readonly links: SignInLinks,
    private readonly codes: EmailCodes,
    private readonly pending: PendingSignIns,
  ) {}

  /**
   * After a password is set or changed, or the account is deactivated: every session (but the
   * one of `keepSessionHash`, the request's own), every link and the open code. Answers how many
   * sessions ended.
   */
  async endAll(
    tx: Transaction,
    userId: string,
    keepSessionHash?: string,
  ): Promise<number> {
    // The code first: a sign-in with it at the same moment either finds it gone, or holds its
    // row until it commits, so the sessions read after see the session it started and end it.
    await this.endMailed(tx, userId);
    return this.sessions.revokeAllOf(tx, userId, keepSessionHash);
  }

  /**
   * Holds the person until `tx` ends (#650), as ending their ways in does: a change that takes a
   * link or a code of theirs before it ends them (setting a password through a link) calls this
   * first, so the person is always taken before their links and their code.
   */
  holdPerson(tx: Transaction, userId: string): Promise<void> {
    return this.codes.holdToEnd(tx, userId);
  }

  /**
   * After a second factor is turned on (#611): the sessions and the open second steps begun
   * without it (but the session of `keepSessionHash`, the request's own). Answers how many
   * sessions ended. What was emailed stays: it leads to the second step now.
   */
  async endWithoutSecondFactor(
    tx: Transaction,
    userId: string,
    keepSessionHash?: string,
  ): Promise<number> {
    await this.holdPerson(tx, userId);
    await this.endOpenSteps(tx, userId);
    return this.sessions.revokeAllOf(tx, userId, keepSessionHash);
  }

  /** The open second steps alone (#611): after a second factor is turned off or reset. */
  endOpenSteps(tx: Transaction, userId: string): Promise<void> {
    return this.pending.revokeAll(tx, userId);
  }

  /**
   * After the address changes: what was emailed to the old one, the links and the open code, and
   * a second step one of them opened. Sessions stay: the person signed in themselves.
   */
  async endMailed(tx: Transaction, userId: string): Promise<void> {
    await this.holdPerson(tx, userId);
    await this.links.revokeAll(tx, userId);
    await this.codes.revokeAll(tx, userId);
    await this.endOpenSteps(tx, userId);
  }
}

/**
 * Whether `next` replaces an address mail went to (`previous`, ignoring case): then what was
 * emailed there ends (`WaysIn.endMailed`). A first address replaces none, so a link an admin
 * copied for someone without one keeps working.
 */
export function addressReplaced(
  previous: string | null,
  next: string | null,
): boolean {
  return previous !== null && previous.toLowerCase() !== next?.toLowerCase();
}
