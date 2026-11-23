import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  type OnApplicationShutdown,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { clientAddress } from '../../base/api/client-address.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { Public } from '../../base/api/public.decorator.js';
import {
  RequestEmailCodeAction,
  SignInWithEmailCodeAction,
  SignInWithEmailLinkAction,
} from '../core/actions/email-code.action.js';
import { isSameOrigin } from './actor.guard.js';
import {
  EmailCodeLinkDocument,
  EmailCodeRequestDocument,
  EmailCodeRequestedDocument,
  EmailCodeSignInDocument,
} from './email-code.resources.js';
import { FailedAuthentications } from './failed-authentications.js';
import { sessionCookie } from './password.controller.js';
import { SignedInDocument } from './password.resources.js';
import { SESSION_COOKIE, setCookie } from './session-cookies.js';
import { SignInSettings } from './sign-in-settings.js';

/** What "Email me a code" always answers. */
export const EMAIL_CODE_ANSWER =
  'If the address is known, a code is on its way.';

const ERROR = { standardSchema: ErrorDocument };

const OFF = {
  description:
    '`email-code-sign-in-off`: signing in with a code by email is off (`CCMS_EMAIL_CODE_SIGN_IN=off`, no email, or demo mode).',
  ...ERROR,
};

const LIMITED = {
  description:
    '`too-many-failed-attempts`: too many tries from this address or for this account; `Retry-After` says when to try again.',
  ...ERROR,
};

const CROSS_ORIGIN = {
  description: '`cross-origin-request`: not from the editor’s origin.',
  ...ERROR,
};

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere; nothing of it was written. `Retry-After` says when to try again.',
  ...ERROR,
};

/**
 * Signing in with a one-time code by email (#634), next to passwords and providers, into the
 * sessions of #37: asking for a code, signing in with it, and with the link in its email. Every
 * route must come from the editor's origin (`isSameOrigin`), so another site cannot sign a browser
 * in to an account of its choosing. Requests and tries count against the client's address
 * (`FailedAuthentications`, `CCMS_AUTH_FAILURES_*`, in memory: a wrong code as a failed
 * authentication, a request under `code-request:`) and toward the account's budgets in the
 * database (the actions: `code-request:`, `code-attempt:`, each its own).
 */
@ApiTags('sign-in')
@Controller('auth/email-code')
@JsonApi()
export class EmailCodeController implements OnApplicationShutdown {
  private readonly log = new Logger('Sign-in');
  /** Codes still being made and queued after their answer went out. */
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly requestAction: RequestEmailCodeAction,
    private readonly codeAction: SignInWithEmailCodeAction,
    private readonly linkAction: SignInWithEmailLinkAction,
    private readonly settings: SignInSettings,
    private readonly failures: FailedAuthentications,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  @Post('request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Email me a code',
    description:
      'When an active person has this address, emails them a six-digit code and a link that signs in, valid `CCMS_EMAIL_CODE_MINUTES` (default 10) minutes, once; a new code revokes the earlier one. Always 202 with the same answer, at once, so neither the answer nor its time says whether the address is known. Recorded as `user.email-code-requested`. Each request counts against the client’s address and toward the address’s code requests (`CCMS_PASSWORD_FAILURES_*`, apart from its tries and from passwords).',
  })
  @ApiAcceptedResponse({ standardSchema: EmailCodeRequestedDocument })
  @ApiConflictResponse(OFF)
  @ApiForbiddenResponse(CROSS_ORIGIN)
  @ApiTooManyRequestsResponse(LIMITED)
  async request(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: EmailCodeRequestDocument }) body: EmailCodeRequestDocument,
  ): Promise<z.infer<typeof EmailCodeRequestedDocument>> {
    this.fromEditor(req);
    const client = `code-request:${clientAddress(req, 64)}`;
    const outcome = await this.counted(res, client, () =>
      this.requestAction.handle({
        email: body.data.attributes.email,
        language: body.data.attributes.language,
      }),
    );
    if ('retryAfter' in outcome) {
      this.failures.forgive(client);
      refuseFor(res, outcome.retryAfter);
    }
    // Answered at once; the work runs after, so its time says nothing about the address.
    const work = outcome.sending
      .catch((error: unknown) => {
        // Its name and message only: a database error's parameters hold the address.
        this.log.error(
          `A sign-in code request failed: ${error instanceof Error ? `${error.name}: ${error.message.split('\n', 1)[0]}` : 'unknown error'}`,
        );
      })
      .finally(() => this.running.delete(work));
    this.running.add(work);
    return { meta: { message: EMAIL_CODE_ANSWER } };
  }

  @Post('sign-in')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign in with a code by email',
    description:
      'Checks the email address and the code emailed to it and starts a session: the cookie `__Host-openfolia-session`, as a password or a provider’s sign-in does, ending the browser’s previous session. The code works once. An unknown address, no code, a wrong code and one past its time are all 401 `invalid-code`, in the same time. A wrong code counts toward the address’s tries (`CCMS_PASSWORD_FAILURES_*`); the try that uses them up revokes the code, and further tries are 429 until the window ends. A code takes five tries at most. Recorded as `user.sign-in` (`data.method` `email-code`).',
  })
  @ApiOkResponse({ standardSchema: SignedInDocument })
  @ApiUnauthorizedResponse({
    description:
      '`invalid-code`: the address or the code is not right, or the code was used or ran out (which is not said).',
    ...ERROR,
  })
  @ApiForbiddenResponse({
    description:
      '`user-deactivated` or `sign-in-not-allowed` (the session policy), said only with the right code; `cross-origin-request`: not from the editor’s origin.',
    ...ERROR,
  })
  @ApiConflictResponse(OFF)
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async signIn(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: EmailCodeSignInDocument }) body: EmailCodeSignInDocument,
  ): Promise<z.infer<typeof SignedInDocument>> {
    this.fromEditor(req);
    // A wrong code is a failed authentication from this address, as a wrong password is.
    const client = clientAddress(req, 64);
    const outcome = await this.counted(res, client, () =>
      this.codeAction.handle({
        email: body.data.attributes.email,
        code: body.data.attributes.code,
        previousToken: sessionCookie(req),
      }),
    );
    if ('retryAfter' in outcome) {
      this.failures.forgive(client);
      refuseFor(res, outcome.retryAfter);
    }
    if ('refused' in outcome) {
      switch (outcome.refused) {
        case 'invalid-code':
          throw new JsonApiException(HttpStatus.UNAUTHORIZED, [
            {
              code: 'invalid-code',
              detail:
                'The email address or the code is not right, or the code has run out.',
            },
          ]);
        case 'user-deactivated':
          this.failures.forgive(client);
          throw new JsonApiException(HttpStatus.FORBIDDEN, [
            {
              code: 'user-deactivated',
              detail: 'This user is deactivated and cannot sign in.',
            },
          ]);
        case 'sign-in-not-allowed':
          this.failures.forgive(client);
          throw notAllowed();
      }
    }
    this.failures.forgive(client);
    setCookie(res, SESSION_COOKIE, outcome.token, this.settings.cookieSeconds);
    return { meta: { userId: outcome.userId } };
  }

  @Post('link')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign in with the link from a code’s email',
    description:
      'Signs in with the token of the link in a code’s email (`<editor>/sign-in-code#<token>`; the token goes in the body, never in an address) and sets the session cookie. The link and its code work once, together. Recorded as `user.sign-in` (`data.method` `email-code`, `via` `link`).',
  })
  @ApiOkResponse({ standardSchema: SignedInDocument })
  @ApiNotFoundResponse({
    description:
      '`link-invalid`: no such link (malformed, used, replaced by a newer code, revoked, or its person deactivated).',
    ...ERROR,
  })
  @ApiGoneResponse({
    description: '`link-expired`: the link ran out; ask for a new code.',
    ...ERROR,
  })
  @ApiForbiddenResponse({
    description:
      '`sign-in-not-allowed` (the session policy); `cross-origin-request`: not from the editor’s origin.',
    ...ERROR,
  })
  @ApiConflictResponse(OFF)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async link(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: EmailCodeLinkDocument }) body: EmailCodeLinkDocument,
  ): Promise<z.infer<typeof SignedInDocument>> {
    this.fromEditor(req);
    const outcome = await this.linkAction.handle({
      token: body.data.attributes.token,
      previousToken: sessionCookie(req),
    });
    if ('refused' in outcome) {
      switch (outcome.refused) {
        case 'link-expired':
          throw new JsonApiException(HttpStatus.GONE, [
            {
              code: 'link-expired',
              detail: 'This link has run out; ask for a new code.',
            },
          ]);
        case 'link-invalid':
          throw new JsonApiException(HttpStatus.NOT_FOUND, [
            {
              code: 'link-invalid',
              detail: 'This link does not work (any more); ask for a new code.',
            },
          ]);
        case 'sign-in-not-allowed':
          throw notAllowed();
      }
    }
    setCookie(res, SESSION_COOKIE, outcome.token, this.settings.cookieSeconds);
    return { meta: { userId: outcome.userId } };
  }

  /**
   * Runs `work` counted against `client` (in memory): 429 while the client is past its limit,
   * else counted before anything is awaited, so requests at once from one address each see the
   * others; taken back when `work` fails. The caller takes it back when the answer is no failure.
   */
  private async counted<T>(
    res: Response,
    client: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const wait = this.failures.retryAfter(client);
    if (wait !== undefined) refuseFor(res, wait);
    this.failures.fail(client);
    try {
      return await work();
    } catch (error) {
      this.failures.forgive(client);
      throw error;
    }
  }

  /** 403 `cross-origin-request` for a request not from the editor's origin. */
  private fromEditor(req: Request): void {
    if (isSameOrigin(req, this.settings.origins)) return;
    throw new JsonApiException(HttpStatus.FORBIDDEN, [
      {
        code: 'cross-origin-request',
        detail: "Signing in must happen on the editor's own origin.",
      },
    ]);
  }
}

function notAllowed(): JsonApiException {
  return new JsonApiException(HttpStatus.FORBIDDEN, [
    {
      code: 'sign-in-not-allowed',
      detail: 'Signing in with a code by email is not allowed for you.',
    },
  ]);
}

/** 429 `too-many-failed-attempts`, to try again in `wait` seconds. */
function refuseFor(res: Response, wait: number): never {
  res.setHeader('Retry-After', String(wait));
  throw new JsonApiException(HttpStatus.TOO_MANY_REQUESTS, [
    {
      code: 'too-many-failed-attempts',
      detail: 'Too many tries; try again later.',
      meta: { retryAfter: wait },
    },
  ]);
}
