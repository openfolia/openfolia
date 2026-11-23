import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  type OnApplicationBootstrap,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../../base/api/public.decorator.js';
import { NotFoundError } from '../../base/core/errors.js';
import { SecretSealer } from '../../base/core/secret-sealer.js';
import { StartupError } from '../../config/startup-error.js';
import { CompleteSignInAction } from '../core/actions/complete-sign-in.action.js';
import { BeginSignInAction } from '../core/actions/sign-in.action.js';
import {
  IdentityProviders,
  type PendingSignIn,
  SignInFailedError,
} from '../core/identity-provider.js';
import {
  clearCookie,
  cookieOf,
  SESSION_COOKIE,
  setCookie,
  SIGN_IN_COOKIE,
  SIGN_IN_SEAL_CONTEXT,
  SIGN_IN_SECONDS,
} from './session-cookies.js';
import { SignInSettings } from './sign-in-settings.js';

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
  /** When it stops counting, in ms since the epoch. */
  until: z.number(),
});

/**
 * The codes the sign-in page shows after a sign-in did not end in a
 * session (`?error=` on the editor's sign-in page): the provider's
 * (`SignInFailure`), the core's refusals and `sign-in-expired` (the
 * sign-in took too long, or was not begun in this browser).
 */
export type SignInErrorCode =
  | 'provider-unavailable'
  | 'access-denied'
  | 'sign-in-failed'
  | 'sign-in-expired'
  | 'user-deactivated'
  | 'sign-in-not-allowed';

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
    if (
      !ProviderId.safeParse(provider).success ||
      !this.providers.find(provider)
    ) {
      throw new NotFoundError(`No identity provider "${provider}".`);
    }
    const returnTo = safeReturnPath(req.query['returnTo']);
    try {
      const begun = await this.begin.handle({ providerId: provider });
      const kept: z.infer<typeof Kept> = {
        provider,
        pending: begun.pending,
        returnTo,
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
      "Where the identity provider sends the browser back. Checks the answer against the sealed cookie, finds or makes the person's user, applies their groups' roles and starts a session: the cookie `__Host-openfolia-session` (`Secure`, `HttpOnly`, `SameSite=Lax`) and a 303 to the editor at `returnTo`. Anything else is a 303 to the editor's sign-in page with `?error=` (`provider-unavailable`, `access-denied`, `sign-in-failed`, `sign-in-expired`, `user-deactivated`, `sign-in-not-allowed`), never more detail. Takes whatever query the provider sends.",
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
    noStore(res);
    // The provider's code is in this address: never passed on as a referrer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    const sealed = cookieOf(req, SIGN_IN_COOKIE);
    // One sign-in, one use: the cookie goes whatever happens.
    clearCookie(res, SIGN_IN_COOKIE);
    if (
      !ProviderId.safeParse(provider).success ||
      !this.providers.find(provider)
    ) {
      throw new NotFoundError(`No identity provider "${provider}".`);
    }
    const kept = this.open(sealed, provider);
    if (!kept) {
      this.toSignInPage(res, 'sign-in-expired');
      return;
    }
    const query = new URL(req.originalUrl, 'http://callback.invalid')
      .searchParams;
    try {
      const outcome = await this.complete.handle({
        providerId: provider,
        callback: query,
        pending: kept.pending as PendingSignIn,
        previousToken: cookieOf(req, SESSION_COOKIE),
      });
      if ('refused' in outcome) {
        this.toSignInPage(res, outcome.refused);
        return;
      }
      setCookie(
        res,
        SESSION_COOKIE,
        outcome.token,
        this.settings.cookieSeconds,
      );
      res.redirect(
        HttpStatus.SEE_OTHER,
        this.settings.editorAddress(kept.returnTo),
      );
    } catch (error) {
      this.failed(res, error);
    }
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

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}
