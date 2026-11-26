import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { qrCodeSvg } from '@openfolia/render-typst';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { clientAddress } from '../../base/api/client-address.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { Public } from '../../base/api/public.decorator.js';
import { DEFAULT_PRODUCT_NAME } from '../../branding/core/branding.js';
import { BrandingStore } from '../../branding/core/branding-store.js';
import {
  BeginSetUpAction,
  ConfirmSetUpAction,
  GetSecondFactorAction,
  NewRecoveryCodesAction,
  ResetSecondFactorAction,
  TurnOffSecondFactorAction,
} from '../core/actions/second-factor.action.js';
import {
  BeginRequiredSetUpAction,
  ConfirmRequiredSetUpAction,
  ReadSecondStepAction,
  type SecondStepRefusal,
  VerifySecondStepAction,
} from '../core/actions/second-factor-sign-in.action.js';
import type { Actor } from '../core/actor.js';
import type { SetUpBegun } from '../core/second-factor-codes.js';
import { hashSessionToken } from '../core/sessions.js';
import { otpauthUrl } from '../core/totp.js';
import { ApiPermission } from './api-permission.decorator.js';
import {
  BeginSecondFactorDocument,
  RecoveryCodesDocument,
  SecondFactorCodeDocument,
  SecondFactorDocument,
  SecondFactorOnDocument,
  SecondFactorProofDocument,
  SecondFactorSetUpDocument,
  SecondStepDocument,
  SecondStepDoneDocument,
  SecondStepSetUpDoneDocument,
} from './second-factor.resources.js';
import {
  clearCookie,
  cookieOf,
  SECOND_FACTOR_COOKIE,
} from './session-cookies.js';
import { SignInAnswer } from './sign-in-answer.js';
import { sessionCookie, SignInAttempts } from './sign-in-attempts.js';

/**
 * The most wrong codes a person's second factor takes per window, whatever the lockout's limit
 * (`CCMS_PASSWORD_FAILURES_MAX`; a lower one holds): six digits must never be guessed without
 * end. Counted per person, so it holds across every sign-in they or anyone begin: a new password
 * step resets nothing. The window is the lockout's (`CCMS_PASSWORD_FAILURES_WINDOW_MS`).
 */
export const MAX_WRONG_CODES = 10;

const SECOND_FACTOR_KEY = 'second-factor:user:';

/** The key wrong codes of a person's second factor count under (`PasswordAttempts`). */
export const secondFactorKey = (userId: string): string =>
  `${SECOND_FACTOR_KEY}${userId}`;

const ERROR = { standardSchema: ErrorDocument };

const NOT_APPLICABLE =
  '`second-factor-not-applicable`: your session did not begin with a password or a code by email (single sign-on is the provider’s to secure).';

const UNAVAILABLE =
  '`second-factor-unavailable`: the server has no instance secret key, or the stored secret cannot be opened.';

const LIMITED = {
  description:
    '`too-many-failed-attempts`: too many wrong codes or passwords from this address or for this account; `Retry-After` says when to try again.',
  ...ERROR,
};

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere; nothing of it was written. `sign-in-busy`: too many passwords are being checked at once. `Retry-After` says when to try again.',
  ...ERROR,
};

const EXPIRED = {
  description:
    '`second-factor-expired`: no second step of this kind is open in this browser (it ran out, was used, or ended with a change of the account): sign in again.',
  ...ERROR,
};

const STEP_REFUSED = {
  description:
    '`wrong-code`: not the code of now, or used before; the step stays open. `user-deactivated`, `sign-in-not-allowed` (the session policy). `cross-origin-request`: not from the editor’s origin.',
  ...ERROR,
};

const WRONG_PROOF = {
  description:
    '`wrong-password`, `wrong-code`: what you gave is not right; `forbidden`: a service account has no second factor.',
  ...ERROR,
};

/**
 * Two-factor sign-in with an authenticator app (#611), for people who sign in here with a
 * password or a code by email: one's own (`/me/second-factor`), the second step of a sign-in
 * (`/auth/second-factor`, public, bound to the browser by its cookie), and an admin's reset.
 *
 * Codes and recovery codes count as failed authentications: against the client's address
 * (`FailedAuthentications`, in memory) and toward the person's total (`PasswordAttempts`, in the
 * database, so a restart or another server counts on), before they are checked; a right one is
 * taken back.
 */
@ApiTags('sign-in')
@Controller()
@JsonApi()
export class SecondFactorController {
  constructor(
    private readonly getAction: GetSecondFactorAction,
    private readonly beginAction: BeginSetUpAction,
    private readonly confirmAction: ConfirmSetUpAction,
    private readonly codesAction: NewRecoveryCodesAction,
    private readonly turnOffAction: TurnOffSecondFactorAction,
    private readonly resetAction: ResetSecondFactorAction,
    private readonly readStep: ReadSecondStepAction,
    private readonly verifyStep: VerifySecondStepAction,
    private readonly beginStep: BeginRequiredSetUpAction,
    private readonly confirmStep: ConfirmRequiredSetUpAction,
    private readonly branding: BrandingStore,
    private readonly attempts: SignInAttempts,
    private readonly answer: SignInAnswer,
  ) {}

  @Get('me/second-factor')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read your second factor',
    description:
      'Whether two-factor sign-in is on for you, how many recovery codes are left and whether the installation requires it. Never the secret or a code.',
  })
  @ApiOkResponse({ standardSchema: SecondFactorDocument })
  @ApiForbiddenResponse({
    description: '`forbidden`: a service account has none.',
    ...ERROR,
  })
  @ApiConflictResponse({ description: NOT_APPLICABLE, ...ERROR })
  async read(
    @Req() req: Request,
    @CurrentActor() actor: Actor,
  ): Promise<z.infer<typeof SecondFactorDocument>> {
    const own = await this.getAction.handle({
      actor,
      provider: req.signInSession?.provider,
    });
    return {
      data: {
        type: 'SecondFactor',
        id: 'own',
        attributes: { enabledAt: own.since?.toISOString() ?? null },
        meta: {
          recoveryCodesLeft: own.recoveryCodesLeft,
          required: own.required,
          available: own.available,
          hasPassword: own.hasPassword,
        },
      },
    };
  }

  @Post('me/second-factor/set-up')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Begin two-factor sign-in',
    description:
      'Makes a new secret for your authenticator app, shown only now; it counts for nothing until `POST /me/second-factor/confirm` confirms it, within ten minutes. Beginning again replaces it. Takes your password when you have one; a wrong one counts as a failed sign-in.',
  })
  @ApiOkResponse({ standardSchema: SecondFactorSetUpDocument })
  @ApiForbiddenResponse(WRONG_PROOF)
  @ApiConflictResponse({
    description: `\`second-factor-on\`: it is on already. ${UNAVAILABLE} ${NOT_APPLICABLE}`,
    ...ERROR,
  })
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async begin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @Body({ schema: BeginSecondFactorDocument })
    body: BeginSecondFactorDocument,
  ): Promise<z.infer<typeof SecondFactorSetUpDocument>> {
    const { password } = body.data.attributes;
    const begun = await this.counted(req, res, `user:${actor.id}`, () =>
      this.beginAction.handle({
        actor,
        provider: req.signInSession?.provider,
        password,
      }),
    );
    return { meta: await this.setUp(begun) };
  }

  @Post('me/second-factor/confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Turn on two-factor sign-in',
    description:
      'Turns it on with a code of the app just set up. Your other sessions end; this one goes on. Answers your recovery codes, once. Recorded as `user.second-factor-on`.',
  })
  @ApiOkResponse({ standardSchema: SecondFactorOnDocument })
  @ApiForbiddenResponse(WRONG_PROOF)
  @ApiConflictResponse({
    description: `\`second-factor-on\`: it is on already. \`second-factor-not-begun\`: no set-up is open (any more). ${UNAVAILABLE} ${NOT_APPLICABLE}`,
    ...ERROR,
  })
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async confirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @Body({ schema: SecondFactorCodeDocument }) body: SecondFactorCodeDocument,
  ): Promise<z.infer<typeof SecondFactorOnDocument>> {
    const token = req.signInSession ? sessionCookie(req) : undefined;
    const on = await this.counted(req, res, secondFactorKey(actor.id), () =>
      this.confirmAction.handle({
        actor,
        provider: req.signInSession?.provider,
        code: body.data.attributes.code,
        sessionHash: token === undefined ? undefined : hashSessionToken(token),
      }),
    );
    return {
      meta: {
        recoveryCodes: [...on.recoveryCodes],
        sessionsEnded: on.sessionsEnded,
      },
    };
  }

  @Post('me/second-factor/recovery-codes')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Make new recovery codes',
    description:
      'Ten new recovery codes, shown only now, in place of every earlier one. Takes your password or a current code again. Recorded as `user.second-factor-recovery-codes`.',
  })
  @ApiOkResponse({ standardSchema: RecoveryCodesDocument })
  @ApiForbiddenResponse(WRONG_PROOF)
  @ApiConflictResponse({
    description: `\`second-factor-off\`: it is not on. ${UNAVAILABLE} ${NOT_APPLICABLE}`,
    ...ERROR,
  })
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async recoveryCodes(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @Body({ schema: SecondFactorProofDocument })
    body: SecondFactorProofDocument,
  ): Promise<z.infer<typeof RecoveryCodesDocument>> {
    const proof = body.data.attributes;
    const made = await this.counted(req, res, proofKey(actor, proof), () =>
      this.codesAction.handle({
        actor,
        provider: req.signInSession?.provider,
        ...proof,
      }),
    );
    return { meta: { recoveryCodes: [...made.recoveryCodes] } };
  }

  @Post('me/second-factor/turn-off')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Turn off two-factor sign-in',
    description:
      'Removes your second factor and its recovery codes. Takes your password or a current code again. Where the installation requires it, you set up a new one at your next sign-in. Recorded as `user.second-factor-off`.',
  })
  @ApiNoContentResponse({ description: 'It is off.' })
  @ApiForbiddenResponse(WRONG_PROOF)
  @ApiConflictResponse({
    description: `\`second-factor-off\`: it is not on. ${UNAVAILABLE} ${NOT_APPLICABLE}`,
    ...ERROR,
  })
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async turnOff(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @Body({ schema: SecondFactorProofDocument })
    body: SecondFactorProofDocument,
  ): Promise<void> {
    const proof = body.data.attributes;
    await this.counted(req, res, proofKey(actor, proof), () =>
      this.turnOffAction.handle({
        actor,
        provider: req.signInSession?.provider,
        ...proof,
      }),
    );
  }

  @Delete('users/:userId/second-factor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Reset a user’s second factor',
    description:
      'Removes another person’s second factor and recovery codes, when they lost both: they sign in without it, and set up a new one at once where the installation requires it. Their sessions go on. Recorded as `user.second-factor-reset`. Needs `admin.roles`.',
  })
  @ApiParam({
    name: 'userId',
    description: 'The user’s ID. One that names no user is 404.',
    schema: { type: 'string' },
  })
  @ApiNoContentResponse({ description: 'Reset.' })
  @ApiNotFoundResponse({
    description: '`not-found`: no such user, or none on.',
    ...ERROR,
  })
  @ApiConflictResponse({
    description:
      '`second-factor-own`: turn off your own in the account menu, with your password or a code.',
    ...ERROR,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async reset(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.resetAction.handle({ actor, userId });
  }

  @Get('auth/second-factor')
  @Public()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Read the open second step',
    description:
      'What the second step of this browser’s sign-in is, from the cookie its first factor set. No session exists until it is taken.',
  })
  @ApiOkResponse({ standardSchema: SecondStepDocument })
  @ApiForbiddenResponse({
    description: '`user-deactivated`, `sign-in-not-allowed`.',
    ...ERROR,
  })
  @ApiGoneResponse(EXPIRED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async step(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof SecondStepDocument>> {
    const open = await this.openStep(req, res);
    return {
      meta: {
        secondFactor: open.step,
        email: open.email,
        expiresAt: open.expiresAt.toISOString(),
      },
    };
  }

  @Post('auth/second-factor/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign in with the second factor',
    description:
      'Takes the second step with a code of the authenticator app or a recovery code, and starts the session. A code is accepted once; a wrong one leaves the step open and counts as a failed sign-in. Recorded as `user.sign-in` (`data.secondFactor`).',
  })
  @ApiOkResponse({ standardSchema: SecondStepDoneDocument })
  @ApiForbiddenResponse(STEP_REFUSED)
  @ApiConflictResponse({ description: UNAVAILABLE, ...ERROR })
  @ApiGoneResponse(EXPIRED)
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async verify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: SecondFactorCodeDocument }) body: SecondFactorCodeDocument,
  ): Promise<z.infer<typeof SecondStepDoneDocument>> {
    this.attempts.fromEditor(req);
    const open = await this.openStep(req, res);
    const done = await this.counted(
      req,
      res,
      secondFactorKey(open.userId),
      () =>
        this.verifyStep.handle({
          token: secondFactorCookie(req),
          code: body.data.attributes.code,
          previousToken: sessionCookie(req),
        }),
    );
    await this.answer.session(res, done.token);
    return { meta: { userId: done.userId } };
  }

  @Post('auth/second-factor/set-up')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Begin a required second factor',
    description:
      'For a sign-in of someone the installation requires two-factor sign-in of and who has none yet: makes a new secret for their app, shown only now. Beginning again replaces it.',
  })
  @ApiOkResponse({ standardSchema: SecondFactorSetUpDocument })
  @ApiForbiddenResponse(STEP_REFUSED)
  @ApiConflictResponse({
    description: `\`second-factor-on\`: it is on already. ${UNAVAILABLE}`,
    ...ERROR,
  })
  @ApiGoneResponse(EXPIRED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async stepSetUp(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof SecondFactorSetUpDocument>> {
    this.attempts.fromEditor(req);
    const begun = await this.beginStep.handle({
      token: secondFactorCookie(req),
    });
    if ('refused' in begun) throw refusal(res, begun.refused);
    return { meta: await this.setUp(begun) };
  }

  @Post('auth/second-factor/confirm')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Turn on a required second factor',
    description:
      'Turns it on with a code of the app just set up, ends the person’s earlier sessions and starts this one. Answers the recovery codes, once. Recorded as `user.second-factor-on` and `user.sign-in`.',
  })
  @ApiOkResponse({ standardSchema: SecondStepSetUpDoneDocument })
  @ApiForbiddenResponse(STEP_REFUSED)
  @ApiConflictResponse({
    description: `\`second-factor-on\`: it is on already. \`second-factor-not-begun\`: no set-up is open (any more). ${UNAVAILABLE}`,
    ...ERROR,
  })
  @ApiGoneResponse(EXPIRED)
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async stepConfirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: SecondFactorCodeDocument }) body: SecondFactorCodeDocument,
  ): Promise<z.infer<typeof SecondStepSetUpDoneDocument>> {
    this.attempts.fromEditor(req);
    const open = await this.openStep(req, res);
    const done = await this.counted(
      req,
      res,
      secondFactorKey(open.userId),
      () =>
        this.confirmStep.handle({
          token: secondFactorCookie(req),
          code: body.data.attributes.code,
          previousToken: sessionCookie(req),
        }),
    );
    await this.answer.session(res, done.token);
    return {
      meta: { userId: done.userId, recoveryCodes: [...done.recoveryCodes] },
    };
  }

  /** The second step open in this browser, or its refusal. */
  private async openStep(req: Request, res: Response) {
    const open = await this.readStep.handle({ token: secondFactorCookie(req) });
    if ('refused' in open) throw refusal(res, open.refused);
    return open;
  }

  /**
   * Runs a check of a password or a code, counted first: the count stays with a wrong one, and
   * is taken back with any other outcome.
   */
  private async counted<T extends object>(
    req: Request,
    res: Response,
    key: string,
    check: () => Promise<T>,
  ): Promise<Exclude<T, { refused: SecondStepRefusal | 'wrong-password' }>> {
    const attempt = await this.attempts.attempt(
      res,
      clientAddress(req, 64),
      key,
      key.startsWith(SECOND_FACTOR_KEY) ? { atMost: MAX_WRONG_CODES } : {},
    );
    let outcome: T;
    try {
      outcome = await check();
    } catch (error) {
      attempt.forgive();
      throw error;
    }
    if ('refused' in outcome) {
      const refused = outcome.refused as SecondStepRefusal | 'wrong-password';
      if (refused !== 'wrong-code' && refused !== 'wrong-password') {
        attempt.forgive();
      }
      throw refusal(res, refused);
    }
    attempt.forgive();
    return outcome as Exclude<
      T,
      { refused: SecondStepRefusal | 'wrong-password' }
    >;
  }

  private async setUp(
    begun: SetUpBegun,
  ): Promise<z.infer<typeof SecondFactorSetUpDocument>['meta']> {
    const { branding } = await this.branding.read();
    const url = otpauthUrl({
      secret: begun.secret,
      issuer: branding.productName ?? DEFAULT_PRODUCT_NAME,
      account: begun.account,
    });
    return {
      secret: begun.secret,
      otpauthUrl: url,
      qrCode: qrCodeSvg(url),
      account: begun.account,
    };
  }
}

/** The open second step's token, from its cookie. */
function secondFactorCookie(req: Request): string | undefined {
  return cookieOf(req, SECOND_FACTOR_COOKIE);
}

/** Where a proof counts: a password as every check of it, a code as every code. */
function proofKey(actor: Actor, proof: { password?: string | undefined }) {
  return proof.password === undefined
    ? secondFactorKey(actor.id)
    : `user:${actor.id}`;
}

function refusal(
  res: Response,
  refused: SecondStepRefusal | 'wrong-password',
): JsonApiException {
  switch (refused) {
    case 'second-step-expired':
      // The cookie is of no use any more.
      clearCookie(res, SECOND_FACTOR_COOKIE);
      return new JsonApiException(HttpStatus.GONE, [
        {
          code: 'second-factor-expired',
          detail: 'This sign-in has run out or was used; sign in again.',
        },
      ]);
    case 'wrong-code':
      return new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'wrong-code',
          detail:
            'The code is not right, or was used before; take the one the app shows now.',
          source: { pointer: '/data/attributes/code' },
        },
      ]);
    case 'wrong-password':
      return new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'wrong-password',
          detail: 'Your password is not right.',
          source: { pointer: '/data/attributes/password' },
        },
      ]);
    case 'user-deactivated':
      return new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'user-deactivated',
          detail: 'This user is deactivated and cannot sign in.',
        },
      ]);
    case 'sign-in-not-allowed':
      return new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'sign-in-not-allowed',
          detail: 'Signing in this way is not allowed for you.',
        },
      ]);
  }
}
