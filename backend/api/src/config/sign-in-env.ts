import { z } from 'zod';
import { LINK_BY_EMAIL } from '../access/core/session-policy.js';
import { field, flag, text, wholeNumber } from './fields.js';

/** `CCMS_SESSION_*` defaults (#37): 8 hours idle, 7 days at most. */
export const DEFAULT_SESSION_IDLE_MINUTES = 480;
export const DEFAULT_SESSION_MAX_HOURS = 168;
export const DEFAULT_OIDC_SCOPES = 'openid profile email';
export const DEFAULT_OIDC_GROUPS_CLAIM = 'groups';
/** `CCMS_INVITE_DAYS` default (#610): an invite link is valid for a week. */
export const DEFAULT_INVITE_DAYS = 7;
/** `CCMS_EMAIL_CODE_MINUTES` default (#634): a code by email works for 10 minutes. */
export const DEFAULT_EMAIL_CODE_MINUTES = 10;

/** A loopback host: plain `http://` is accepted there (local runs and tests). */
export const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

/**
 * An `https://` URL (or `http://` on a loopback host) without credentials
 * or fragment; `query` says whether a query is allowed.
 */
const secureUrl = (what: string, { query }: { query: boolean }) =>
  z
    .string()
    .trim()
    .refine(
      (value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' && isLoopbackHost(url.hostname))) &&
          url.username === '' &&
          url.password === '' &&
          url.hash === '' &&
          (query || url.search === '')
        );
      },
      `must be an https:// ${what} (http:// only on localhost or 127.0.0.1), without credentials${query ? '' : ', query'} or fragment`,
    );

/**
 * Sign-in with OpenID Connect and people's sessions (#37): part of `Env`.
 * `CCMS_OIDC_ISSUER` turns sign-in on; the other `CCMS_OIDC_*` settings
 * then say how. Never together with demo mode (`checkSignInEnv`).
 */
export const SignInEnv = z.object({
  /** The provider's issuer URL; its discovery document is read from it. Unset: no sign-in. */
  CCMS_OIDC_ISSUER: field(
    // Kept as written: an issuer is compared exactly as the provider names it.
    secureUrl('URL', { query: false }).optional(),
  ),
  /** The client ID the provider gave this server. */
  CCMS_OIDC_CLIENT_ID: field(text.pipe(z.string().max(500)).optional()),
  /** The client secret; unset: a public client (PKCE alone). Never logged. */
  CCMS_OIDC_CLIENT_SECRET: field(text.pipe(z.string().max(2000)).optional()),
  /** The callback address as the browser reaches it: `<editor>/api/auth/oidc/callback`. */
  CCMS_OIDC_REDIRECT_URL: field(
    secureUrl('URL', { query: false })
      .transform((value) => new URL(value).href)
      .optional(),
  ),
  /** The scopes asked for, space-separated; must hold `openid`. */
  CCMS_OIDC_SCOPES: field(
    text
      .pipe(z.string().max(1000))
      .transform((value) => value.split(/\s+/).filter(Boolean))
      .refine((scopes) => scopes.includes('openid'), 'must include openid')
      .refine(
        (scopes) => scopes.every((s) => /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(s)),
        'scopes are printable ASCII without " or \\',
      )
      .default(DEFAULT_OIDC_SCOPES.split(' ')),
  ),
  /** The claim holding the groups: a name, or a dotted path into nested claims. */
  CCMS_OIDC_GROUPS_CLAIM: field(
    text.pipe(z.string().max(200)).default(DEFAULT_OIDC_GROUPS_CLAIM),
  ),
  /** Whether a first sign-in links to an existing user by verified email (`LinkByEmail`). */
  CCMS_OIDC_LINK_BY_EMAIL: field(
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(LINK_BY_EMAIL, 'must be pending, off or any'))
      .default('pending'),
  ),
  /** The provider's name on the sign-in button; unset: the editor's own wording. */
  CCMS_OIDC_NAME: field(text.pipe(z.string().max(60)).optional()),
  /** The editor's address, where a sign-in and a sign-out end; default: the redirect URL's origin. */
  CCMS_EDITOR_URL: field(
    secureUrl('URL', { query: false })
      .transform((value) => new URL(value).href)
      .transform((href) => (href.endsWith('/') ? href : `${href}/`))
      .optional(),
  ),
  /**
   * Sign-in with an email address and a password (#610): `on` (the default, but never in demo
   * mode) or `off` (only a provider and tokens: for organisations that require their provider).
   * Unset: on unless `CCMS_AUTH_MODE=demo` (`passwordSignInOn`).
   */
  CCMS_PASSWORD_SIGN_IN: field(
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(['on', 'off'], 'must be on or off'))
      .optional(),
  ),
  /**
   * The first admin, made on the first start of an instance without users (#373): their email
   * address. Ignored once the instance has a user. Their one-time link is printed in the log.
   */
  CCMS_FIRST_ADMIN_EMAIL: field(
    z
      .string()
      .trim()
      .pipe(z.email('must be an email address').max(254))
      .optional(),
  ),
  /**
   * Whether the first start logs the first admin's one-time link (default true). false: the
   * start makes the admin without a link; `first-admin` on the command line prints one.
   */
  CCMS_FIRST_ADMIN_LINK_LOG: field(flag.default(true)),
  /** The first admin's name (default: the address's local part). */
  CCMS_FIRST_ADMIN_NAME: field(text.pipe(z.string().max(200)).optional()),
  /**
   * Sign-in with a one-time code by email (#634): `on` or `off`. Unset: on wherever email is set
   * up (`CCMS_MAIL_URL`) and password sign-in is on; beside a provider alone, or as the only way
   * to sign in (#639), only when `on`; never in demo mode (`emailCodeSignInOn`).
   */
  CCMS_EMAIL_CODE_SIGN_IN: field(
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(['on', 'off'], 'must be on or off'))
      .optional(),
  ),
  /** How many minutes a code by email and its link work (default 10, from 1 to 60). */
  CCMS_EMAIL_CODE_MINUTES: field(
    wholeNumber(1, 60).default(DEFAULT_EMAIL_CODE_MINUTES),
  ),
  /** How many days an invite link is valid (default 7). */
  CCMS_INVITE_DAYS: field(wholeNumber(1, 90).default(DEFAULT_INVITE_DAYS)),
  /** A session ends this many minutes after its last request (default 480: 8 hours). */
  CCMS_SESSION_IDLE_MINUTES: field(
    wholeNumber(5, 43_200).default(DEFAULT_SESSION_IDLE_MINUTES),
  ),
  /** A session ends this many hours after sign-in, however busy (default 168: 7 days). */
  CCMS_SESSION_MAX_HOURS: field(
    wholeNumber(1, 8_760).default(DEFAULT_SESSION_MAX_HOURS),
  ),
});
export type SignInSettings = z.infer<typeof SignInEnv>;

/**
 * What sign-in needs together: the client ID and redirect URL with an
 * issuer; the redirect URL on the editor's origin (the session cookie is
 * the editor's); and never demo mode, where anyone holding the token acts
 * as anyone.
 */
export function checkSignInEnv(
  env: SignInSettings & {
    readonly CCMS_AUTH_MODE: string;
    readonly CCMS_API_TOKEN?: string | undefined;
    readonly CCMS_MAIL_URL?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (env.CCMS_EMAIL_CODE_SIGN_IN === 'on') {
    const problem =
      env.CCMS_AUTH_MODE === 'demo'
        ? 'sign-in by email code and demo mode (CCMS_AUTH_MODE=demo) cannot be on together: in demo mode anyone holding the token acts as anyone. Unset one of them.'
        : env.CCMS_MAIL_URL === undefined
          ? 'needs email (CCMS_MAIL_URL): the code is sent by email.'
          : undefined;
    if (problem !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['CCMS_EMAIL_CODE_SIGN_IN'],
        message: problem,
      });
    }
  }
  if (env.CCMS_PASSWORD_SIGN_IN === 'on' && env.CCMS_AUTH_MODE === 'demo') {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_PASSWORD_SIGN_IN'],
      message:
        'password sign-in and demo mode (CCMS_AUTH_MODE=demo) cannot be on together: in demo mode anyone holding the token acts as anyone. Unset one of them.',
    });
  }
  if (env.CCMS_OIDC_ISSUER === undefined) {
    for (const key of [
      'CCMS_OIDC_CLIENT_ID',
      'CCMS_OIDC_CLIENT_SECRET',
      'CCMS_OIDC_REDIRECT_URL',
    ] as const) {
      if (env[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'needs CCMS_OIDC_ISSUER (sign-in is off without it)',
        });
      }
    }
    return;
  }
  if (env.CCMS_AUTH_MODE === 'demo') {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_OIDC_ISSUER'],
      message:
        'sign-in with OpenID Connect and demo mode (CCMS_AUTH_MODE=demo) cannot be on together: in demo mode anyone holding the token acts as anyone. Unset one of them.',
    });
  }
  // The shared token reads every ref, drafts included: with sign-in on, whoever holds it (an
  // editor proxy adding it to every call) would read without signing in. Only for a local
  // provider (a loopback issuer: local runs and tests).
  if (
    env.CCMS_API_TOKEN !== undefined &&
    !isLoopbackHost(new URL(env.CCMS_OIDC_ISSUER).hostname)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_API_TOKEN'],
      message:
        "cannot be set with sign-in (CCMS_OIDC_ISSUER): the shared token reads everything without signing in. Unset it (and the editor proxy's CCMS_EDITOR_API_TOKEN); machine clients use service account tokens.",
    });
  }
  for (const key of [
    'CCMS_OIDC_CLIENT_ID',
    'CCMS_OIDC_REDIRECT_URL',
  ] as const) {
    if (env[key] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'is required with CCMS_OIDC_ISSUER',
      });
    }
  }
  const redirect = env.CCMS_OIDC_REDIRECT_URL;
  if (
    redirect !== undefined &&
    env.CCMS_EDITOR_URL !== undefined &&
    new URL(redirect).origin !== new URL(env.CCMS_EDITOR_URL).origin
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_OIDC_REDIRECT_URL'],
      message:
        "must be on CCMS_EDITOR_URL's origin (the editor's /api), where the session cookie belongs",
    });
  }
}

/** The editor's address: `CCMS_EDITOR_URL`, else the redirect URL's origin. */
export function editorUrlOf(env: SignInSettings): string | undefined {
  if (env.CCMS_EDITOR_URL !== undefined) return env.CCMS_EDITOR_URL;
  return env.CCMS_OIDC_REDIRECT_URL === undefined
    ? undefined
    : `${new URL(env.CCMS_OIDC_REDIRECT_URL).origin}/`;
}

/**
 * Whether people sign in with an email address and a password (#610): unless
 * `CCMS_PASSWORD_SIGN_IN=off`, and never in demo mode (where the settings check refuses an
 * explicit `on`).
 */
export function passwordSignInOn(env: {
  readonly CCMS_PASSWORD_SIGN_IN?: 'on' | 'off' | undefined;
  readonly CCMS_AUTH_MODE: string;
}): boolean {
  return env.CCMS_PASSWORD_SIGN_IN !== 'off' && env.CCMS_AUTH_MODE !== 'demo';
}

/**
 * Whether people may sign in with a one-time code by email (#634), as far as the settings say:
 * unless `CCMS_EMAIL_CODE_SIGN_IN=off`, only with email (`CCMS_MAIL_URL`) and never in demo
 * mode. Unset, it is on only with password sign-in: beside a provider alone, or alone (#639), it
 * takes an explicit `on`. Whether email really goes out (the secret key) is asked when it is
 * offered.
 */
export function emailCodeSignInOn(env: {
  readonly CCMS_EMAIL_CODE_SIGN_IN?: 'on' | 'off' | undefined;
  readonly CCMS_PASSWORD_SIGN_IN?: 'on' | 'off' | undefined;
  readonly CCMS_MAIL_URL?: unknown;
  readonly CCMS_AUTH_MODE: string;
}): boolean {
  return (
    env.CCMS_EMAIL_CODE_SIGN_IN !== 'off' &&
    env.CCMS_AUTH_MODE !== 'demo' &&
    env.CCMS_MAIL_URL !== undefined &&
    // Unset, it comes with passwords only: an instance that turned passwords off for its
    // provider (MFA, offboarding there) must not gain a way around it on an upgrade, and one
    // with neither turns codes on only by saying so.
    (env.CCMS_EMAIL_CODE_SIGN_IN === 'on' || passwordSignInOn(env))
  );
}
