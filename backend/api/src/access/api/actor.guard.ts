import { createHash, timingSafeEqual } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { clientAddress } from '../../base/api/client-address.js';
import { JsonApiException } from '../../base/api/json-api.exception.js';
import { IS_PUBLIC } from '../../base/api/public.decorator.js';
import { TOKEN_ONLY } from '../../base/api/token-only.decorator.js';
import type { Env } from '../../config/env.js';
import { AuthenticateServiceTokenAction } from '../core/actions/authenticate-service-token.action.js';
import { AuthenticateSessionAction } from '../core/actions/authenticate-session.action.js';
import { ResolveActorAction } from '../core/actions/resolve-actor.action.js';
import { IdentityProviders } from '../core/identity-provider.js';
import { isServiceToken, serviceTokenId } from '../core/service-token.js';
import { EMAIL_CODE_PROVIDER } from '../core/email-codes.js';
import { PASSWORD_PROVIDER } from '../core/passwords.js';
import { FailedAuthentications } from './failed-authentications.js';
import {
  type AnswersEveryone,
  OPTIONAL_ACTOR,
} from './optional-actor.decorator.js';
import { cookieOf, SESSION_COOKIE } from './session-cookies.js';
import { SignInSettings } from './sign-in-settings.js';

declare global {
  // Express's own extension point for its `Request`.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The person's session the request acts through (#37), set by the
       * guard with `actor`; undefined for a token.
       */
      signInSession?: { readonly provider: string; readonly expiresAt: Date };
      /**
       * The public ID of the service account token the request acts
       * through (#877: its reads are recorded), set by the guard with
       * `actor`; undefined for anything else. Never the token itself.
       */
      serviceTokenId?: string;
    }
  }
}

/**
 * Whether a request comes from the editor's origin: its `Origin`, when sent, is one of
 * `origins` (with none configured, the browser's `Sec-Fetch-Site` must say same-origin);
 * without one, `Sec-Fetch-Site` (when sent) says same-origin or none. Behind the cross-site
 * guard's content-type rule and `SameSite=Lax`, a third check.
 */
export function isSameOrigin(
  req: Request,
  origins: ReadonlySet<string>,
): boolean {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (typeof origin === 'string') {
    if (origins.size > 0) return origins.has(origin);
    return site === 'same-origin';
  }
  return site === undefined || site === 'same-origin' || site === 'none';
}

/** Methods that change nothing. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Demo mode: the seeded user a request acts as. Never authenticates on its own. */
// Compatibility: keeps the working name from before the product was named OpenFolia, as every `X-Ccms-*` header
// of the API: they are part of its contract with clients and webhook receivers.
export const USER_HEADER = 'X-Ccms-User';

/**
 * Sent by the editor with what it asks by itself while nobody uses the tab (a poll): the session
 * is checked as ever, but not kept alive by it (#378). It only ever shortens a session, so nothing
 * about it needs to be trusted.
 */
export const BACKGROUND_HEADER = 'X-Ccms-Background';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** The bearer token of `Authorization: Bearer <token>`; undefined for none or another scheme. */
const bearerOf = (authorization: string): string | undefined =>
  /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];

/**
 * On every route not marked `@Public()`: authenticates the bearer token,
 * then sets `request.actor` (read it with `@CurrentActor()`).
 *
 * - A service account's token (`ccms_sat_…`, #38) acts as that service
 *   account, with its roles; checked against the database on every
 *   request, so a revocation or deactivation applies at once. 401
 *   `token-revoked` or `token-expired` only for a caller holding the right
 *   secret, 403 `service-account-deactivated`; `X-Ccms-User` is refused with it.
 * - The shared token (`CCMS_API_TOKEN`, only when set: local use and demo
 *   mode) acts as its read-only service, or in demo mode
 *   (`CCMS_AUTH_MODE=demo`) as the seeded user `X-Ccms-User` names (403
 *   `unknown-user`); outside demo mode the header is refused (400).
 *
 * - A person's session (#37), the cookie `__Host-openfolia-session`, when sign-in
 *   is on (a provider, passwords or codes by email: `SignInSettings.signInOn`): checked first, and then it alone decides (an `Authorization`
 *   header beside it is ignored). 401 `session-expired` past its limits,
 *   401 `unauthorized` for one unknown or signed out, 403
 *   `user-deactivated`; on an `@OptionalActor()` route a session that
 *   cannot act is no session: the request goes on as anyone's.
 *   `X-Ccms-User` is refused with it; a request that may change something
 *   from another origin than the editor's is 403 `cross-origin-request`.
 *   Never counted as a failed authentication (256 random bits).
 *
 * - On an `@OptionalActor(everyone)` route that answers everyone alike right now (a `public`
 *   stable address, #608), none of the above: no actor, nothing counted or refused, and no
 *   `Vary` on any credential, whatever session, token or `X-Ccms-User` comes with it.
 *
 * Anything else is 401 `unauthorized`. Each failed authentication counts
 * against the client's address (`FailedAuthentications`); past the limit,
 * 429 `too-many-failed-attempts`: at once for the shared token or none,
 * and for a service token that does not authenticate (a valid one still
 * acts, so a client sharing the address is not locked out). No token is
 * ever logged: errors name what failed, never what was sent.
 */
@Injectable()
export class ActorGuard implements CanActivate {
  /** Compared as digests: equal length, so the comparison takes constant time. */
  private readonly expected: Buffer | undefined;
  private readonly demo: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
    private readonly modules: ModuleRef,
    private readonly resolveActor: ResolveActorAction,
    private readonly authenticateToken: AuthenticateServiceTokenAction,
    private readonly authenticateSession: AuthenticateSessionAction,
    private readonly providers: IdentityProviders,
    private readonly signIn: SignInSettings,
    private readonly failures: FailedAuthentications,
  ) {
    const shared = config.get('CCMS_API_TOKEN', { infer: true });
    this.expected = shared === undefined ? undefined : digest(shared);
    this.demo = config.get('CCMS_AUTH_MODE', { infer: true }) === 'demo';
    const log = new Logger('Authentication');
    if (this.demo) {
      log.warn(
        [
          '*** DEMO MODE (CCMS_AUTH_MODE=demo) ***',
          `Anyone holding the API token can act as any user in the database by sending ${USER_HEADER}.`,
          'Use it only for demonstrations with seeded users, never where real people sign in.',
        ].join('\n'),
      );
    } else if (shared !== undefined) {
      log.warn(
        signIn.password || signIn.emailCode
          ? 'CCMS_API_TOKEN is set: the shared token reads every ref, drafts included, sign-in or not; an editor proxy holding it (CCMS_EDITOR_API_TOKEN) lets anyone reaching the editor read them without signing in. Use service accounts in a deployment and leave it empty.'
          : 'CCMS_API_TOKEN is set: the shared token reads every ref, drafts included. Use service accounts in a deployment and leave it empty.',
      );
    }
    if (signIn.password && providers.list().length > 0) {
      log.warn(
        'Password sign-in is on beside OpenID Connect: anyone an admin invites can sign in with a password, past the provider. Set CCMS_PASSWORD_SIGN_IN=off to sign in with the provider only.',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const optional = this.reflector.getAllAndOverride<
      true | Type<AnswersEveryone> | undefined
    >(OPTIONAL_ACTOR, [context.getHandler(), context.getClass()]);
    // A route that answers everyone alike right now (a `public` stable address, #608): nothing
    // sent is looked at, so nothing is counted or refused and the answer varies by none of it.
    if (
      typeof optional === 'function' &&
      (await this.modules.get(optional, { strict: false }).answersEveryone())
    ) {
      return true;
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    // By /64 at most: a lockout must never reach a neighbour's addresses.
    const client = clientAddress(req, 64);
    const wait = this.failures.retryAfter(client);
    const limited = (): never => {
      res.setHeader('Retry-After', String(wait));
      throw new JsonApiException(HttpStatus.TOO_MANY_REQUESTS, [
        {
          code: 'too-many-failed-attempts',
          detail:
            'Too many failed authentications from this address; try again later.',
          meta: { retryAfter: wait },
        },
      ]);
    };
    const refuse = (code: string, detail: string): never => {
      if (wait !== undefined) return limited();
      this.failures.fail(client);
      res.setHeader('WWW-Authenticate', 'Bearer');
      throw new JsonApiException(HttpStatus.UNAUTHORIZED, [{ code, detail }]);
    };

    // Who the request acts as changes the answer, so caches must key on it.
    res.vary(USER_HEADER);
    const token = bearerOf(req.headers.authorization ?? '');
    const requested = req.headers[USER_HEADER.toLowerCase()];
    const lenient = optional !== undefined;
    // Sessions count only while some way of signing in is on (a provider, passwords or codes by
    // email, #639): a cookie left from before is nothing. On a
    // route anyone may read (`@OptionalActor()`: the stable addresses) a valid session acts
    // as its person, so `signed-in` addresses open in the editor; one that cannot act is
    // ignored, so a browser holding an ended session still reads what anyone may.
    // A route a token alone authenticates (`@TokenOnly()`, #377) never reads a session.
    const tokenOnly = this.reflector.getAllAndOverride<boolean>(TOKEN_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const signInOn =
      !tokenOnly && this.signIn.signInOn(this.providers.list().length);
    const session = signInOn ? cookieOf(req, SESSION_COOKIE) : undefined;
    // An answer to anyone there is the same with or without a cookie: only one a session
    // changed varies by it, so a shared cache keeps one copy of a public address.
    if (signInOn && !lenient) res.vary('Cookie');
    if (
      session !== undefined &&
      (await this.actAsSession(req, session, requested, lenient))
    ) {
      if (lenient) res.vary('Cookie');
      return true;
    }
    // A route anyone may read (`@OptionalActor()`), asked without any credentials: no actor,
    // and nothing counted as a failed authentication. Anything sent is checked as below.
    if (
      req.headers.authorization === undefined &&
      requested === undefined &&
      lenient
    ) {
      res.vary('Authorization');
      return true;
    }
    const serviceToken = token !== undefined && isServiceToken(token);
    // Past the limit, only a service account's token is still checked (256
    // random bits: no guessing them, so a valid one goes through and other
    // clients behind the same address are not locked out); anything else
    // is refused before a token is compared.
    if (wait !== undefined && !serviceToken) limited();

    if (serviceToken) {
      // A failing store rejects here: a 5xx, never counted as a failure.
      const result = await this.authenticateToken.handle({ token });
      if ('actor' in result) {
        if (requested !== undefined) {
          throw new JsonApiException(HttpStatus.BAD_REQUEST, [
            {
              code: 'user-header-not-accepted',
              detail: `${USER_HEADER} is not accepted with a service account's token; send the request without it.`,
              source: { header: USER_HEADER },
            },
          ]);
        }
        req.actor = result.actor;
        req.serviceTokenId = serviceTokenId(token);
        return true;
      }
      switch (result.refused) {
        case 'token-revoked':
          return refuse('token-revoked', 'This token was revoked.');
        case 'token-expired':
          return refuse('token-expired', 'This token has expired.');
        case 'service-account-deactivated':
          // 403, not 401: the token is valid, so a client must not drop it.
          throw new JsonApiException(HttpStatus.FORBIDDEN, [
            {
              code: 'service-account-deactivated',
              detail:
                'The service account of this token is deactivated and cannot act.',
            },
          ]);
        default:
          return refuse('unauthorized', 'A valid API token is required.');
      }
    }

    if (
      token === undefined ||
      this.expected === undefined ||
      !timingSafeEqual(digest(token), this.expected)
    ) {
      return refuse('unauthorized', 'A valid API token is required.');
    }

    // Node joins a repeated header with ", ", which is no user ID. Should it
    // ever arrive as a list, it is joined the same way: present, never dropped.
    const resolution = await this.resolveActor.handle({
      requestedUser: Array.isArray(requested)
        ? requested.join(', ')
        : requested,
      demo: this.demo,
    });
    if ('actor' in resolution) {
      req.actor = resolution.actor;
      return true;
    }
    if (resolution.refused === 'demo-mode-off') {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'demo-mode-off',
          detail: `${USER_HEADER} is only accepted in demo mode; send the request without it.`,
          source: { header: USER_HEADER },
        },
      ]);
    }
    // 403, not 401: the token is valid, so a client must not drop it.
    if (resolution.refused === 'user-deactivated') {
      throw new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'user-deactivated',
          detail: `The user ${USER_HEADER} names is deactivated and cannot act.`,
          source: { header: USER_HEADER },
        },
      ]);
    }
    throw new JsonApiException(HttpStatus.FORBIDDEN, [
      {
        code: 'unknown-user',
        detail: `${USER_HEADER} names no user.`,
        source: { header: USER_HEADER },
      },
    ]);
  }

  /**
   * A person's session (#37): sets the actor and answers true, or throws why
   * it cannot act; with `lenient` (an `@OptionalActor()` route) a session
   * that cannot act answers false instead, and the request goes on without it.
   */
  private async actAsSession(
    req: Request,
    token: string,
    requested: string | string[] | undefined,
    lenient: boolean,
  ): Promise<boolean> {
    if (requested !== undefined) {
      throw new JsonApiException(HttpStatus.BAD_REQUEST, [
        {
          code: 'user-header-not-accepted',
          detail: `${USER_HEADER} is not accepted with a session; send the request without it.`,
          source: { header: USER_HEADER },
        },
      ]);
    }
    if (!SAFE_METHODS.has(req.method.toUpperCase()) && !this.sameOrigin(req)) {
      throw new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'cross-origin-request',
          detail:
            "A signed-in request that changes something must come from the editor's own origin.",
        },
      ]);
    }
    // A failing store rejects here: a 5xx, never a refusal.
    const found = await this.authenticateSession.handle({
      token,
      background: req.headers[BACKGROUND_HEADER.toLowerCase()] !== undefined,
    });
    // A session counts only while the way in it began with is on: a password session ends when
    // password sign-in is turned off (#610: with a provider still on, that means "sign in with
    // the provider only"), and one from a provider no longer set up ends with it (#639: now that
    // codes alone read sessions, a provider removed for them leaves none acting). Sessions begun
    // with a code by email end with codes turned off, here and in the session policy
    // (`EnvSessionPolicy`, #634).
    const result =
      'actor' in found && !this.wayInOn(found.session.provider)
        ? ({ refused: 'invalid-session' } as const)
        : found;
    if ('actor' in result) {
      req.actor = result.actor;
      req.signInSession = result.session;
      return true;
    }
    if (lenient) return false;
    if (result.refused === 'user-deactivated') {
      throw new JsonApiException(HttpStatus.FORBIDDEN, [
        {
          code: 'user-deactivated',
          detail: 'The signed-in user is deactivated and cannot act.',
        },
      ]);
    }
    throw new JsonApiException(HttpStatus.UNAUTHORIZED, [
      result.refused === 'session-expired'
        ? {
            code: 'session-expired',
            detail: 'The session has ended; sign in again.',
          }
        : {
            code: 'unauthorized',
            detail: 'The session is not valid; sign in again.',
          },
    ]);
  }

  /** Whether the way in a session began with (its `provider`) is on now. */
  private wayInOn(provider: string): boolean {
    if (provider === PASSWORD_PROVIDER) return this.signIn.password;
    if (provider === EMAIL_CODE_PROVIDER) return this.signIn.emailCode;
    return this.providers.list().some((p) => p.id === provider);
  }

  /**
   * Whether a request comes from the editor's origin: its `Origin`, when
   * sent, is one of `SignInSettings.origins`; without one, the browser's
   * `Sec-Fetch-Site` (when sent) says same-origin or none. Behind the
   * cross-site guard's content-type rule and `SameSite=Lax`, a third check.
   */
  private sameOrigin(req: Request): boolean {
    return isSameOrigin(req, this.signIn.origins);
  }
}
