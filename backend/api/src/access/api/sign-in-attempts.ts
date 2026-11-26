import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import {
  type PasswordAttempt,
  PasswordAttempts,
} from '../core/password-attempts.js';
import type { BrowserTokens } from '../core/session-start.js';
import { SESSION_TOKEN_PATTERN } from '../core/sessions.js';
import { isSameOrigin } from './actor.guard.js';
import { FailedAuthentications } from './failed-authentications.js';
import {
  cookieOf,
  SECOND_FACTOR_COOKIE,
  SESSION_COOKIE,
} from './session-cookies.js';
import { SignInSettings } from './sign-in-settings.js';

/**
 * What every route that checks a credential asks first (#610, #611): that the request comes from
 * the editor, and that neither its client's address nor its account is past its limit.
 */
@Injectable()
export class SignInAttempts {
  private readonly log = new Logger('Sign-in');

  constructor(
    private readonly settings: SignInSettings,
    private readonly failures: FailedAuthentications,
    private readonly attempts: PasswordAttempts,
  ) {}

  /** 403 `cross-origin-request` for a request not from the editor's origin. */
  fromEditor(req: Request): void {
    if (isSameOrigin(req, this.settings.origins)) return;
    throw new JsonApiException(HttpStatus.FORBIDDEN, [
      {
        code: 'cross-origin-request',
        detail: "Signing in must happen on the editor's own origin.",
      },
    ]);
  }

  /**
   * A password check from `client` for `account`: 429 while either is past its limit, else
   * counted as failed at once (the account's in the same step as its test); `forgive` takes it
   * back when the check did not fail.
   */
  async attempt(
    res: Response,
    client: string,
    account: string,
    options?: { readonly atMost?: number },
  ): Promise<{ forgive: () => void }> {
    const attempt = await this.countBoth(res, client, account, options);
    return {
      // Best effort, never the answer: a failure to take it back leaves one count too many.
      forgive: () => {
        this.failures.forgive(client);
        this.attempts.forgive(attempt).catch((error: unknown) => {
          this.log.warn(
            `A password attempt could not be taken back: ${error instanceof Error ? error.name : 'unknown error'}`,
          );
        });
      },
    };
  }

  /**
   * Counts a request against `client` (in memory) and toward `account`'s total (in the
   * database): the client's count first, before anything is awaited, so requests at once from
   * one address each see the others; taken back when the account refuses or cannot be counted.
   */
  async countBoth(
    res: Response,
    client: string,
    account: string,
    options?: { readonly atMost?: number },
  ): Promise<PasswordAttempt> {
    this.refuseWhileLimited(res, [client]);
    this.failures.fail(client);
    let counted: Awaited<ReturnType<PasswordAttempts['reserve']>>;
    try {
      counted = await this.attempts.reserve(account, options);
    } catch (error) {
      this.failures.forgive(client);
      throw error;
    }
    if ('retryAfter' in counted) {
      this.failures.forgive(client);
      this.refuseFor(res, counted.retryAfter);
    }
    return counted.attempt;
  }

  /** 429 `too-many-failed-attempts` while any of the client `keys` is past its limit. */
  refuseWhileLimited(res: Response, keys: readonly string[]): void {
    const wait = this.failures.retryAfterAny(keys);
    if (wait !== undefined) this.refuseFor(res, wait);
  }

  /** 429 `too-many-failed-attempts`, to try again in `wait` seconds. */
  refuseFor(res: Response, wait: number): never {
    res.setHeader('Retry-After', String(wait));
    throw new JsonApiException(HttpStatus.TOO_MANY_REQUESTS, [
      {
        code: 'too-many-failed-attempts',
        detail: 'Too many failed sign-ins; try again later.',
        meta: { retryAfter: wait },
      },
    ]);
  }
}

/** What the browser brings to a sign-in, which ends it: its session, and its open second step. */
export function browserTokens(req: Request): BrowserTokens {
  return {
    previousToken: sessionCookie(req),
    openStepToken: cookieOf(req, SECOND_FACTOR_COOKIE),
  };
}

/** The browser's session token, when it holds a well-formed one. */
export function sessionCookie(req: Request): string | undefined {
  const token = cookieOf(req, SESSION_COOKIE);
  return token !== undefined && SESSION_TOKEN_PATTERN.test(token)
    ? token
    : undefined;
}
