import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { PENDING_SIGN_IN_MS } from '../core/pending-sign-ins.js';
import { sessionLimitsOf } from '../core/refused-sign-ins.js';
import type { StartedSignIn } from '../core/session-start.js';
import { SignInRules, SignInSetup } from '../core/sign-in-rules.js';
import type { SignedInDocument } from './password.resources.js';
import {
  clearCookie,
  SECOND_FACTOR_COOKIE,
  SESSION_COOKIE,
  setCookie,
} from './session-cookies.js';

/** How a sign-in is answered: its cookie, and what is left to do (#611). */
@Injectable()
export class SignInAnswer {
  constructor(
    private readonly rules: SignInRules,
    private readonly setup: SignInSetup,
  ) {}

  /** After the first factor: the session's cookie, or the second step's. */
  async started(
    res: Response,
    outcome: { readonly userId: string } & StartedSignIn,
  ): Promise<z.infer<typeof SignedInDocument>> {
    if ('token' in outcome) {
      await this.session(res, outcome.token);
      return { meta: { userId: outcome.userId, secondFactor: null } };
    }
    setCookie(
      res,
      SECOND_FACTOR_COOKIE,
      outcome.pendingToken,
      PENDING_SIGN_IN_MS / 1000,
    );
    return { meta: { userId: null, secondFactor: outcome.secondStep } };
  }

  /**
   * The session's cookie, for the longest a session may last now; a second step this browser had
   * open is left behind.
   */
  async session(res: Response, token: string): Promise<void> {
    const { maxMs } = sessionLimitsOf(await this.rules.read(), this.setup);
    setCookie(res, SESSION_COOKIE, token, maxMs / 1000);
    clearCookie(res, SECOND_FACTOR_COOKIE);
  }
}
