import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  type OnApplicationBootstrap,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { clientAddress } from '../../base/api/client-address.js';
import { AcceptsCrossSiteForm } from '../../base/api/cross-site.guard.js';
import { Public } from '../../base/api/public.decorator.js';
import { NotFoundError } from '../../base/core/errors.js';
import { SecretSealer } from '../../base/core/secret-sealer.js';
import { StartupError } from '../../config/startup-error.js';
import { CompleteSignInAction } from '../core/actions/complete-sign-in.action.js';
import { BeginSignInAction } from '../core/actions/sign-in.action.js';
import {
  type IdentityProvider,
  IdentityProviders,
  type PendingSignIn,
  SignInFailedError,
} from '../core/identity-provider.js';
import { FailedAuthentications } from './failed-authentications.js';
import {
  clearCookie,
  cookieOf,
  SECOND_FACTOR_COOKIE,
  SESSION_COOKIE,
  setCookie,
  SIGN_IN_COOKIE,
  SIGN_IN_SEAL_CONTEXT,
  SIGN_IN_SECONDS,
} from './session-cookies.js';
import { heldBefore } from '../core/session-start.js';
import { SignInAnswer } from './sign-in-answer.js';
import { SignInSettings } from './sign-in-settings.js';

const FORM = 'application/x-www-form-urlencoded';

/** A provider's ID in a path: a lowercase key. */
const ProviderId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

/** Where to go back to after signing in: a path inside the editor, at most 2,000 characters. */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2000) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) {
    return '/';
  }
  // Control characters (a header split, a hidden scheme) make it no path worth keeping.
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === '\\') return '/';
  }
  return raw;
}

/** What the sealed sign-in cookie holds. */
const Kept = z.strictObject({
  provider: z.string(),
  pending: z.record(z.string(), z.string()),
  returnTo: z.string(),
  /**
   * The hash (never the token) of the session the browser held, for a provider whose posted
   * answer comes without that session's cookie (#934).
   */
  previousSession: z.string().optional(),
  /** The same of the second step it had open (#611). */
  openStep: z.string().optional(),
  /** When it stops counting, in ms since the epoch. */
  until: z.number(),
});

/**
 * The codes the sign-in page shows after a sign-in did not end in a
 * session (`?error=` on the editor's sign-in page): the provider's
 * (`SignInFailure`), the core's refusals, `sign-in-expired` (the
 * sign-in took too long, or was not begun in this browser) and
 * `too-many-failed-attempts` (posted answers refused, from one client).
 */
export type SignInErrorCode =
  | 'provider-unavailable'
  | 'access-denied'
  | 'sign-in-failed'
  | 'sign-in-expired'
  | 'user-deactivated'
  | 'sign-in-not-allowed'
  | 'too-many-failed-attempts';

/**
 * The browser's side of signing in (#37): not JSON:API, as these are
 * addresses a browser is sent to (the editor's "Sign in" button, the
 * provider's redirect back), answering with redirects. Public: nobody is
 * acting yet. The API's own routes for the editor (`GET /auth/providers`,
 * `POST /auth/sign-out`) are in `AuthController`.
 */
@ApiTags('sign-in')
@Controller('auth')
@Public()
export class SignInController implements OnApplicationBootstrap {
  private readonly log = new Logger('Sign-in');

  constructor(
    private readonly begin: BeginSignInAction,
    private readonly complete: CompleteSignInAction,
    private readonly providers: IdentityProviders,
    private readonly sealer: SecretSealer,
    private readonly settings: SignInSettings,
    private readonly failures: FailedAuthentications,
    private readonly answer: SignInAnswer,
  ) {}

  /** Sign-in keeps its sealed cookie under the instance key: none, no sign-in. */
  onApplicationBootstrap(): void {
    if (this.providers.list().length > 0 && !this.sealer.available) {
      throw new StartupError(
        'Sign-in needs the instance secret key (CCMS_SECRET_KEY, or its key file), which is not available.',
      );
    }
  }

  @Get(':provider/sign-in')
  @ApiOperation({
    summary: 'Begin signing in (browser)',
    description:
      "Where the editor's sign-in button sends the browser: a 303 to the identity provider, with a sealed cookie (`__Host-openfolia-sign-in`, ten minutes) holding what the callback checks (state, nonce, PKCE verifier). `returnTo`: a path inside the editor to go back to (default `/`). When the provider cannot be reached, a 303 to the editor's sign-in page with `?error=provider-unavailable`.",
  })
  @ApiParam({ name: 'provider', example: 'oidc' })
  @ApiQuery({ name: 'returnTo', required: false, example: '/manuals' })
  @ApiResponse({
    status: HttpStatus.SEE_OTHER,
    description: 'To the provider.',
  })
  async signIn(
    @Req() req: Request,
    @Res() res: Response,
    @Param('provider') provider: string,
  ): Promise<void> {
    noStore(res);
    const offered = this.providerOf(provider);
    const returnTo = safeReturnPath(req.query['returnTo']);
    try {
      const begun = await this.begin.handle({ providerId: provider });
      // A redirect's answer carries the session cookie itself (`SameSite=Lax`).
      const held = offered.answersByPost
        ? heldBefore({
            previousToken: cookieOf(req, SESSION_COOKIE),
            openStepToken: cookieOf(req, SECOND_FACTOR_COOKIE),
          })
        : {};
      const kept: z.infer<typeof Kept> = {
        provider,
        pending: begun.pending,
        returnTo,
        ...(held.sessionHash !== undefined && {
          previousSession: held.sessionHash,
        }),
        ...(held.stepHash !== undefined && { openStep: held.stepHash }),
        until: Date.now() + SIGN_IN_SECONDS * 1000,
      };
      setCookie(
        res,
        SIGN_IN_COOKIE,
        this.sealer.seal(
          JSON.stringify(kept),
          `${SIGN_IN_SEAL_CONTEXT}:${provider}`,
        ),
        SIGN_IN_SECONDS,
        sameSiteOf(offered.answersByPost),
      );
      res.redirect(HttpStatus.SEE_OTHER, begun.authorizationUrl);
    } catch (error) {
      this.failed(res, error);
    }
  }

  @Get(':provider/callback')
  @ApiOperation({
    summary: 'Finish signing in (browser)',
    description:
      "Where the identity provider sends the browser back. Checks the answer against the sealed cookie, finds or makes the person's user, applies their groups' roles and starts a session, ending the browser's previous one and the second step it had open: the cookie `__Host-openfolia-session` (`Secure`, `HttpOnly`, `SameSite=Lax`) and a 303 to the editor at `returnTo`. Anything else is a 303 to the editor's sign-in page with `?error=` (`provider-unavailable`, `access-denied`, `sign-in-failed`, `sign-in-expired`, `user-deactivated`, `sign-in-not-allowed`), never more detail. Takes whatever query the provider sends.",
  })
  @ApiParam({ name: 'provider', example: 'oidc' })
  @ApiResponse({
    status: HttpStatus.SEE_OTHER,
    description:
      'To the editor, signed in; or to its sign-in page, with `?error=`.',
  })
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Param('provider') provider: string,
  ): Promise<void> {
    // A provider that posts its answer (`answersByPost`) has no answer in a query.
    const offered = this.answering(res, provider, false);
    await this.finish(
      req,
      res,
      offered,
      new URL(req.originalUrl, 'http://callback.invalid').searchParams,
    );
  }

  @Post(':provider/callback')
  @AcceptsCrossSiteForm()
  @ApiOperation({
    summary: 'Finish signing in, posted (browser)',
    description:
      "Where an identity provider that answers with a form posts the browser back (SAML's HTTP-POST binding, the assertion consumer service: `SAMLResponse`). Checks the answer (with the sealed cookie, here `SameSite=None`, when the sign-in began here; without it only when IdP-initiated sign-in is allowed) and answers as `GET /auth/{provider}/callback` does. Refused answers count against the client's address (`CCMS_AUTH_FAILURES_*`, apart from its other failed authentications); past the limit, a 303 to the sign-in page with `?error=too-many-failed-attempts`. 404 for a provider that answers with a redirect.",
  })
  @ApiParam({ name: 'provider', example: 'saml' })
  @ApiConsumes(FORM)
  @ApiResponse({
    status: HttpStatus.SEE_OTHER,
    description:
      'To the editor, signed in; or to its sign-in page, with `?error=`.',
  })
  async postedCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Param('provider') provider: string,
  ): Promise<void> {
    const offered = this.answering(res, provider, true);
    const answer = new URLSearchParams();
    const body: unknown = req.body;
    // Only a form, as providers post it (its parser bounds the fields): a JSON body is no answer.
    if (req.is(FORM) && typeof body === 'object' && body !== null) {
      for (const [name, value] of Object.entries(body)) {
        if (typeof value === 'string') answer.set(name, value);
      }
    }
    await this.finish(
      req,
      res,
      offered,
      answer,
      `sign-in-answer:${clientAddress(req, 64)}`,
    );
  }

  @Get(':provider/metadata')
  @ApiOperation({
    summary: "This server's metadata for the identity provider",
    description:
      "The service provider metadata of a provider that has one (SAML: entity ID, assertion consumer service, signed assertions wanted), for the identity provider's administrator to import. 404 for any other provider.",
  })
  @ApiParam({ name: 'provider', example: 'saml' })
  @ApiProduces('application/samlmetadata+xml')
  @ApiResponse({ status: HttpStatus.OK, description: 'The metadata (XML).' })
  metadata(@Res() res: Response, @Param('provider') provider: string): void {
    const document = this.providerOf(provider).serviceMetadata();
    if (document === undefined) {
      throw new NotFoundError(`No metadata for "${provider}".`);
    }
    res
      .status(HttpStatus.OK)
      .type('application/samlmetadata+xml')
      .send(document);
  }

  /**
   * The provider offered as `id` that answers this way (`byPost`); 404 for none. Whatever comes
   * of it: never kept, its address (a code) never a referrer, and the sign-in cookie goes (one
   * sign-in, one use).
   */
  private answering(
    res: Response,
    id: string,
    byPost: boolean,
  ): IdentityProvider {
    noStore(res);
    res.setHeader('Referrer-Policy', 'no-referrer');
    clearCookie(res, SIGN_IN_COOKIE, sameSiteOf(byPost));
    const provider = this.providerOf(id);
    if (provider.answersByPost !== byPost) {
      throw new NotFoundError(`No identity provider "${id}".`);
    }
    return provider;
  }

  /**
   * Checks the provider's answer against the sign-in kept, and starts the session. With `client`,
   * an answer refused counts against it, and past its limit none is checked: anyone can post one,
   * and checking it costs far more than posting it (#934). Counted before the check and taken back
   * unless the provider's check refuses it, so answers at once cannot all pass the limit.
   */
  private async finish(
    req: Request,
    res: Response,
    provider: IdentityProvider,
    answer: URLSearchParams,
    client?: string,
  ): Promise<void> {
    const sealed = cookieOf(req, SIGN_IN_COOKIE);
    const kept =
      this.open(sealed, provider.id) ??
      // Begun at the provider (IdP-initiated), when it may be: nothing kept for it (none, or one
      // left by another provider's sign-in), the editor's start. What the browser held is not
      // known then (a posted answer comes without its cookies): only its cookies are replaced.
      (provider.acceptsUnsolicited
        ? {
            pending: {},
            returnTo: '/',
            previousSession: undefined,
            openStep: undefined,
          }
        : undefined);
    if (!kept) {
      this.toSignInPage(res, 'sign-in-expired');
      return;
    }
    if (client !== undefined) {
      if (this.failures.retryAfter(client) !== undefined) {
        this.toSignInPage(res, 'too-many-failed-attempts');
        return;
      }
      this.failures.fail(client);
    }
    let refused = false;
    try {
      const outcome = await this.complete.handle({
        providerId: provider.id,
        callback: answer,
        pending: kept.pending as PendingSignIn,
        previousToken: cookieOf(req, SESSION_COOKIE),
        openStepToken: cookieOf(req, SECOND_FACTOR_COOKIE),
        heldAtBegin: {
          sessionHash: kept.previousSession,
          stepHash: kept.openStep,
        },
      });
      if ('refused' in outcome) {
        this.toSignInPage(res, outcome.refused);
        return;
      }
      await this.answer.session(res, outcome.token);
      res.redirect(
        HttpStatus.SEE_OTHER,
        this.settings.editorAddress(kept.returnTo),
      );
    } catch (error) {
      refused =
        error instanceof SignInFailedError &&
        error.reason !== 'provider-unavailable';
      this.failed(res, error);
    } finally {
      if (client !== undefined && !refused) this.failures.forgive(client);
    }
  }

  /** The provider offered as `id`; 404 for none. */
  private providerOf(id: string): IdentityProvider {
    const provider = ProviderId.safeParse(id).success
      ? this.providers.find(id)
      : undefined;
    if (!provider) throw new NotFoundError(`No identity provider "${id}".`);
    return provider;
  }

  /** The kept sign-in, when the cookie opens for this provider and has not run out. */
  private open(
    sealed: string | undefined,
    provider: string,
  ): z.infer<typeof Kept> | undefined {
    if (sealed === undefined) return undefined;
    try {
      const kept = Kept.parse(
        JSON.parse(
          this.sealer.open(sealed, `${SIGN_IN_SEAL_CONTEXT}:${provider}`),
        ),
      );
      return kept.provider === provider && kept.until > Date.now()
        ? kept
        : undefined;
    } catch {
      return undefined;
    }
  }

  private failed(res: Response, error: unknown): void {
    if (error instanceof SignInFailedError) {
      this.toSignInPage(res, error.reason);
      return;
    }
    // Its name and message only: a database error's parameters hold personal data.
    this.log.error(
      `A sign-in failed: ${error instanceof Error ? `${error.name}: ${error.message.split('\n', 1)[0]}` : 'unknown error'}`,
    );
    this.toSignInPage(res, 'sign-in-failed');
  }

  private toSignInPage(res: Response, code: SignInErrorCode): void {
    res.redirect(
      HttpStatus.SEE_OTHER,
      this.settings.editorAddress(`/sign-in?error=${code}`),
    );
  }
}

/** The sign-in cookie's `SameSite`: `None` for a provider whose answer is a cross-site form. */
const sameSiteOf = (answersByPost: boolean) => (answersByPost ? 'None' : 'Lax');

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}
