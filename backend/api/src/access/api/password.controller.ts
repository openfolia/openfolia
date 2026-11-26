import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Logger,
  type OnApplicationShutdown,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
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
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { clientAddress } from '../../base/api/client-address.js';
import { CurrentActor } from '../../base/api/current-actor.decorator.js';
import { JsonApi } from '../../base/api/json-api.decorators.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { ErrorDocument } from '../../base/api/json-api.js';
import { Public } from '../../base/api/public.decorator.js';
import {
  ChangePasswordAction,
  PasswordSignInAction,
} from '../core/actions/password-sign-in.action.js';
import {
  CreateSignInLinkAction,
  ForgotPasswordAction,
  ReadSignInLinkAction,
  SetPasswordWithLinkAction,
  WithdrawInviteAction,
} from '../core/actions/sign-in-links.action.js';
import type { Actor } from '../core/actor.js';
import { RequestEmailCodeAction } from '../core/actions/email-code.action.js';
import { IdentityProviders } from '../core/identity-provider.js';
import { hashSessionToken } from '../core/sessions.js';
import type { SignInLinkKind } from '../core/sign-in-links.js';
import { ApiPermission } from './api-permission.decorator.js';
import { accountKey } from './failed-authentications.js';
import {
  ChangePasswordDocument,
  ForgotPasswordAcceptedDocument,
  ForgotPasswordDocument,
  PasswordChangedDocument,
  PasswordSignInDocument,
  SetPasswordDocument,
  SignedInDocument,
  SignInLinkDocument,
  SignInLinkMadeDocument,
  SignInLinkQueryDocument,
  SignInOptionsDocument,
} from './password.resources.js';
import { requiresSingleSignOn, SignInRules } from '../core/sign-in-rules.js';
import { SignInAnswer } from './sign-in-answer.js';
import {
  browserTokens,
  sessionCookie,
  SignInAttempts,
} from './sign-in-attempts.js';
import { SignInSettings } from './sign-in-settings.js';

/** What "Forgot password" always answers. */
export const FORGOT_PASSWORD_ANSWER =
  'If the address is known, an email is on its way.';

const ERROR = { standardSchema: ErrorDocument };

const OFF = {
  description:
    '`password-sign-in-off`: signing in with a password is off (`CCMS_PASSWORD_SIGN_IN=off`, or demo mode).',
  ...ERROR,
};

const LIMITED = {
  description:
    '`too-many-failed-attempts`: too many failed sign-ins from this address or for this account; `Retry-After` says when to try again.',
  ...ERROR,
};

const RULES = {
  description:
    '`password-too-short` (fewer than 12 characters), `password-too-long` (more than 256), `password-too-common` (a common password, a run along the keyboard, the person’s own address): `meta.minLength`, `meta.maxLength`.',
  ...ERROR,
};

const LINK_GONE = {
  description: '`link-expired`: the link ran out; ask for a new one.',
  ...ERROR,
};

const LINK_INVALID = {
  description:
    '`link-invalid`: no such link (malformed, used, replaced by a newer one, withdrawn, or its person deactivated).',
  ...ERROR,
};

const USER_ID = {
  name: 'userId',
  description: 'The user’s ID. One that names no user is 404.',
  schema: { type: 'string' },
} as const;

const TIMEOUT = {
  description:
    '`database-timeout`: the transaction waited too long for a row held elsewhere; nothing of it was written. `sign-in-busy`: too many passwords are being checked at once. `Retry-After` says when to try again.',
  ...ERROR,
};

const NO_EMAIL = {
  description:
    '`no-email-address`: the person has no email address to sign in with; add one first.',
  ...ERROR,
};

/**
 * Signing in with an email address and a password (#610), into the sessions of #37: the
 * sign-in page's options, signing in, "Forgot password", the pages a one-time link opens,
 * changing one's password, and an admin's invites and reset links.
 *
 * The public routes that change something (`POST /auth/password/…`) must come from the
 * editor's origin, as a signed-in change must (`isSameOrigin`), so another site cannot sign a
 * browser in to an account of its choosing. Failed password checks count against the client's
 * address (`FailedAuthentications`, `CCMS_AUTH_FAILURES_*`, in memory) and against the account
 * (`PasswordAttempts`, `CCMS_PASSWORD_FAILURES_*`, in the database; "Forgot password" requests
 * for an address count apart, under the same limit); past either limit, 429 before any password is checked. An attempt counts
 * before its check and is taken back when right, so attempts at once cannot slip past it.
 */
@ApiTags('sign-in')
@Controller()
@JsonApi()
export class PasswordController implements OnApplicationShutdown {
  private readonly log = new Logger('Sign-in');
  /** "Forgot password" requests still running after their answer went out. */
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly signInAction: PasswordSignInAction,
    private readonly changeAction: ChangePasswordAction,
    private readonly makeLink: CreateSignInLinkAction,
    private readonly withdraw: WithdrawInviteAction,
    private readonly readLink: ReadSignInLinkAction,
    private readonly setWithLink: SetPasswordWithLinkAction,
    private readonly forgot: ForgotPasswordAction,
    private readonly providers: IdentityProviders,
    private readonly settings: SignInSettings,
    private readonly attempts: SignInAttempts,
    private readonly answer: SignInAnswer,
    private readonly emailCode: RequestEmailCodeAction,
    private readonly rules: SignInRules,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  @Get('auth/options')
  @Public()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign-in options',
    description:
      'What the sign-in page offers: the email and password form, “Forgot password” (only when email can carry the link), “Email me a code” (#634, only when email is set up), and how many identity providers; or, with single sign-on required, the providers alone and whether there is an emergency sign-in (never whose). Anyone may ask, before signing in.',
  })
  @ApiOkResponse({ standardSchema: SignInOptionsDocument })
  async options(): Promise<z.infer<typeof SignInOptionsDocument>> {
    const rule = await this.rules.read();
    const required = requiresSingleSignOn(rule);
    return {
      data: {
        type: 'SignInOptions',
        id: 'sign-in',
        attributes: {
          password: this.settings.password && !required,
          passwordReset: await this.forgot.offered(),
          emailCode: this.emailCode.offered && !required,
          providers: this.providers.list().length,
          singleSignOn: required,
          emergencySignIn: required && rule.breakGlass?.problem === null,
        },
      },
    };
  }

  @Post('auth/password/sign-in')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Sign in with a password',
    description:
      'Checks the email address and password and starts a session: the cookie `__Host-openfolia-session`, as a provider’s sign-in does, ending the browser’s previous session; or, with a second factor on or required (`meta.secondFactor`), no session yet but the second step’s cookie (`POST /auth/second-factor/…`). An unknown address, a person without a password, a wrong password and, while single sign-on is required, anyone but the break-glass account are all 401 `invalid-credentials`, in the same time. Recorded as `user.sign-in` (`data.method` `password`).',
  })
  @ApiOkResponse({ standardSchema: SignedInDocument })
  @ApiUnauthorizedResponse({
    description:
      '`invalid-credentials`: the address or the password is not right (which is not said).',
    ...ERROR,
  })
  @ApiForbiddenResponse({
    description:
      '`user-deactivated`, said only with the right password; `cross-origin-request`: not from the editor’s origin.',
    ...ERROR,
  })
  @ApiConflictResponse(OFF)
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async signIn(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: PasswordSignInDocument }) body: PasswordSignInDocument,
  ): Promise<z.infer<typeof SignedInDocument>> {
    this.attempts.fromEditor(req);
    const { email, password } = body.data.attributes;
    const attempt = await this.attempts.attempt(
      res,
      clientAddress(req, 64),
      `sign-in:${accountKey(email)}`,
    );
    let outcome: Awaited<ReturnType<PasswordSignInAction['handle']>>;
    try {
      outcome = await this.signInAction.handle({
        email,
        password,
        ...browserTokens(req),
      });
    } catch (error) {
      attempt.forgive();
      throw error;
    }
    if (!('refused' in outcome) || outcome.refused !== 'invalid-credentials') {
      attempt.forgive();
    }
    if ('refused' in outcome) {
      switch (outcome.refused) {
        case 'invalid-credentials':
          throw new JsonApiException(HttpStatus.UNAUTHORIZED, [
            {
              code: 'invalid-credentials',
              detail: 'The email address or the password is not right.',
            },
          ]);
        case 'user-deactivated':
          throw new JsonApiException(HttpStatus.FORBIDDEN, [
            {
              code: 'user-deactivated',
              detail: 'This user is deactivated and cannot sign in.',
            },
          ]);
      }
    }
    return this.answer.started(res, outcome);
  }

  @Post('auth/password/forgot')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Forgot password',
    description:
      'When an active person has this address, emails them a link to choose a new password (valid 1 hour, once; it replaces their earlier link), at most once a minute. Always 202 with the same answer, at once, so neither the answer nor its time says whether the address is known. Recorded as `user.password-reset-requested` (`data.via` `email`). Each request counts against the client’s address, and toward the address’s reset requests (`CCMS_PASSWORD_FAILURES_*`, apart from its failed sign-ins: neither blocks the other).',
  })
  @ApiAcceptedResponse({ standardSchema: ForgotPasswordAcceptedDocument })
  @ApiNotFoundResponse({
    description:
      '`not-configured`: “Forgot password” is not offered (no email, or no `CCMS_PUBLIC_URL`, or password sign-in off).',
    ...ERROR,
  })
  @ApiForbiddenResponse({
    description: '`cross-origin-request`: not from the editor’s origin.',
    ...ERROR,
  })
  @ApiTooManyRequestsResponse(LIMITED)
  async forgotPassword(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: ForgotPasswordDocument }) body: ForgotPasswordDocument,
  ): Promise<z.infer<typeof ForgotPasswordAcceptedDocument>> {
    this.attempts.fromEditor(req);
    if (!(await this.forgot.offered())) {
      throw new JsonApiException(HttpStatus.NOT_FOUND, [
        {
          code: 'not-configured',
          detail:
            'Resetting a password by email is not set up on this server; ask an administrator for a reset link.',
        },
      ]);
    }
    // Counted against the client's address and toward the address's reset requests, each a
    // budget of its own: failed sign-ins never block a reset, nor resets a sign-in. Alike
    // whether anyone has the address.
    const client = `forgot:${clientAddress(req, 64)}`;
    await this.attempts.countBoth(
      res,
      client,
      `reset:${accountKey(body.data.attributes.email)}`,
    );
    // Answered at once; the work runs after, so its time says nothing about the address.
    const work = this.forgot
      .handle({ email: body.data.attributes.email })
      .catch((error: unknown) => {
        // Its name and message only: a database error's parameters hold the address.
        this.log.error(
          `A password reset request failed: ${error instanceof Error ? `${error.name}: ${error.message.split('\n', 1)[0]}` : 'unknown error'}`,
        );
      })
      .finally(() => this.running.delete(work));
    this.running.add(work);
    return { meta: { message: FORGOT_PASSWORD_ANSWER } };
  }

  @Post('auth/password/link')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Open a one-time link',
    description:
      'What a link to set a password is for (an invite or a reset), whose it is and until when it works, for the page it opens. The token goes in the body, never in an address. Using it is `POST /auth/password/set`.',
  })
  @ApiOkResponse({ standardSchema: SignInLinkDocument })
  @ApiNotFoundResponse(LINK_INVALID)
  @ApiGoneResponse(LINK_GONE)
  @ApiConflictResponse(OFF)
  @ApiForbiddenResponse({
    description: '`cross-origin-request`: not from the editor’s origin.',
    ...ERROR,
  })
  async link(
    @Req() req: Request,
    @Body({ schema: SignInLinkQueryDocument }) body: SignInLinkQueryDocument,
  ): Promise<z.infer<typeof SignInLinkDocument>> {
    this.attempts.fromEditor(req);
    const opened = await this.readLink.handle({
      token: body.data.attributes.token,
    });
    if ('refused' in opened) throw linkRefusal(opened.refused);
    return {
      meta: {
        kind: opened.kind,
        name: opened.name,
        email: opened.email,
        expiresAt: opened.expiresAt.toISOString(),
      },
    };
  }

  @Post('auth/password/set')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Set a password with a one-time link',
    description:
      'Sets the person’s password through their invite or reset link and signs them in (the session cookie, or the second step’s first: `meta.secondFactor`). The link works once. **Every other session of the person ends.** Recorded as `user.password-set` (`data.via` `invite` or `reset`) and `user.sign-in`. A password the rules refuse leaves the link working.',
  })
  @ApiOkResponse({ standardSchema: SignedInDocument })
  @ApiNotFoundResponse(LINK_INVALID)
  @ApiGoneResponse(LINK_GONE)
  @ApiUnprocessableEntityResponse(RULES)
  @ApiConflictResponse(OFF)
  @ApiForbiddenResponse({
    description: '`cross-origin-request`: not from the editor’s origin.',
    ...ERROR,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  async setPassword(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body({ schema: SetPasswordDocument }) body: SetPasswordDocument,
  ): Promise<z.infer<typeof SignedInDocument>> {
    this.attempts.fromEditor(req);
    const outcome = await this.setWithLink.handle({
      token: body.data.attributes.token,
      password: body.data.attributes.password,
      ...browserTokens(req),
    });
    if ('refused' in outcome) {
      throw linkRefusal(outcome.refused);
    }
    return this.answer.started(res, outcome);
  }

  @Post('me/password')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Checks your current password, then sets the new one. Your other sessions end; this one goes on. An open reset link and an open code by email end too. Recorded as `user.password-changed`. A wrong current password counts as a failed sign-in.',
  })
  @ApiOkResponse({ standardSchema: PasswordChangedDocument })
  @ApiForbiddenResponse({
    description:
      '`wrong-password`: the current password is not right; `forbidden`: a service account has none.',
    ...ERROR,
  })
  @ApiConflictResponse({
    description: `\`no-password\`: you sign in with your identity provider only. ${OFF.description}`,
    ...ERROR,
  })
  @ApiUnprocessableEntityResponse(RULES)
  @ApiTooManyRequestsResponse(LIMITED)
  @ApiServiceUnavailableResponse(TIMEOUT)
  async changePassword(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @CurrentActor() actor: Actor,
    @Body({ schema: ChangePasswordDocument }) body: ChangePasswordDocument,
  ): Promise<z.infer<typeof PasswordChangedDocument>> {
    const attempt = await this.attempts.attempt(
      res,
      clientAddress(req, 64),
      `user:${actor.id}`,
    );
    const token = req.signInSession ? sessionCookie(req) : undefined;
    let outcome: Awaited<ReturnType<ChangePasswordAction['handle']>>;
    try {
      outcome = await this.changeAction.handle({
        actor,
        currentPassword: body.data.attributes.currentPassword,
        newPassword: body.data.attributes.newPassword,
        sessionHash: token === undefined ? undefined : hashSessionToken(token),
      });
    } catch (error) {
      attempt.forgive();
      throw error;
    }
    if (!('refused' in outcome)) attempt.forgive();
    if ('refused' in outcome) {
      throw new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'wrong-password',
          detail: 'Your current password is not right.',
          source: { pointer: '/data/attributes/currentPassword' },
        },
      ]);
    }
    return { meta: { sessionsEnded: outcome.sessionsEnded } };
  }

  @Post('users/:userId/invite')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Invite a user',
    description:
      'Makes a one-time link for the person to choose their password and sign in, valid `CCMS_INVITE_DAYS` (default 7) days, shown once (`meta.url`, `meta.token`). It replaces their earlier link. Emailed to their address too when email is set up (`meta.emailed`). Recorded as `user.invite`. Needs `admin.roles`.',
  })
  @ApiParam(USER_ID)
  @ApiCreatedResponse({ standardSchema: SignInLinkMadeDocument })
  @ApiNotFoundResponse({ description: '`not-found`: no such user.', ...ERROR })
  @ApiConflictResponse({
    description: `\`user-deactivated\`: reactivate them first. \`single-sign-on-required\`: the installation requires single sign-on, so nobody could sign in with the password. ${OFF.description}`,
    ...ERROR,
  })
  @ApiUnprocessableEntityResponse(NO_EMAIL)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  invite(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<z.infer<typeof SignInLinkMadeDocument>> {
    return this.issueLink(actor, userId, 'invite');
  }

  @Post('users/:userId/password-reset')
  @HttpCode(HttpStatus.CREATED)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Make a password reset link',
    description:
      'Makes a one-time link for the person to choose a new password, valid 1 hour, shown once (`meta.url`, `meta.token`). It replaces their earlier link (an open invite too). Emailed to their address too when email is set up. Their sessions end only once they set the password. Recorded as `user.password-reset-requested` (`data.via` `admin`). Needs `admin.roles`.',
  })
  @ApiParam(USER_ID)
  @ApiCreatedResponse({ standardSchema: SignInLinkMadeDocument })
  @ApiNotFoundResponse({ description: '`not-found`: no such user.', ...ERROR })
  @ApiConflictResponse({
    description: `\`user-deactivated\`: reactivate them first. \`single-sign-on-required\`: the installation requires single sign-on, so nobody could sign in with the password. ${OFF.description}`,
    ...ERROR,
  })
  @ApiUnprocessableEntityResponse(NO_EMAIL)
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  passwordReset(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<z.infer<typeof SignInLinkMadeDocument>> {
    return this.issueLink(actor, userId, 'reset');
  }

  @Delete('users/:userId/invite')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Withdraw an invite',
    description:
      'The person’s open invite link stops working. Recorded as `user.invite-withdraw`. Needs `admin.roles`.',
  })
  @ApiParam(USER_ID)
  @ApiNoContentResponse({ description: 'Withdrawn.' })
  @ApiNotFoundResponse({
    description: '`not-found`: no such user, or no open invite.',
    ...ERROR,
  })
  @ApiServiceUnavailableResponse(TIMEOUT)
  @ApiPermission('admin.roles')
  async withdrawInvite(
    @CurrentActor() actor: Actor,
    @Param('userId') userId: string,
  ): Promise<void> {
    await this.withdraw.handle({ actor, userId });
  }

  private async issueLink(
    actor: Actor,
    userId: string,
    kind: SignInLinkKind,
  ): Promise<z.infer<typeof SignInLinkMadeDocument>> {
    const made = await this.makeLink.handle({ actor, userId, kind });
    return {
      meta: {
        token: made.token,
        url: made.url,
        expiresAt: made.expiresAt.toISOString(),
        emailed: made.emailed,
      },
    };
  }
}

function linkRefusal(
  refused: 'link-invalid' | 'link-expired',
): JsonApiException {
  return refused === 'link-expired'
    ? new JsonApiException(HttpStatus.GONE, [
        {
          code: 'link-expired',
          detail: 'This link has run out; ask for a new one.',
        },
      ])
    : new JsonApiException(HttpStatus.NOT_FOUND, [
        {
          code: 'link-invalid',
          detail: 'This link does not work (any more); ask for a new one.',
        },
      ]);
}
