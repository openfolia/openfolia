import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import {
  editorUrlOf,
  emailCodeSignInOn,
  passwordSignInOn,
} from '../../config/sign-in-env.js';

/** Sign-in's settings as the API layer needs them (#37), read once. */
@Injectable()
export class SignInSettings {
  /** Whether a provider is configured (`CCMS_OIDC_ISSUER`). */
  readonly enabled: boolean;
  /** Whether people sign in with a password (#610; `CCMS_PASSWORD_SIGN_IN`, never in demo mode). */
  readonly password: boolean;
  /**
   * Whether the settings let people sign in with a code by email (#634; `emailCodeSignInOn`,
   * whether or not email goes out right now).
   */
  readonly emailCode: boolean;
  /**
   * The editor's address, ending in `/`: where sign-ins and sign-outs end (`CCMS_EDITOR_URL`,
   * else the provider's redirect URL's origin). Undefined when neither says.
   */
  readonly editorUrl: string | undefined;
  /**
   * Origins a request with a session cookie may come from: the editor's, the public URL's
   * (`CCMS_PUBLIC_URL`, the editor in a deployment) and `CCMS_EDITOR_ORIGINS`. Empty: the
   * browser's `Sec-Fetch-Site` decides (`ActorGuard.sameOrigin`).
   */
  readonly origins: ReadonlySet<string>;
  /** How long the browser keeps the session cookie: the longest a session may last, in seconds. */
  readonly cookieSeconds: number;

  constructor(config: ConfigService<Env, true>) {
    const env = {
      CCMS_OIDC_ISSUER: config.get('CCMS_OIDC_ISSUER', { infer: true }),
      CCMS_OIDC_REDIRECT_URL: config.get('CCMS_OIDC_REDIRECT_URL', {
        infer: true,
      }),
      CCMS_EDITOR_URL: config.get('CCMS_EDITOR_URL', { infer: true }),
    };
    this.enabled = env.CCMS_OIDC_ISSUER !== undefined;
    const ways = {
      CCMS_PASSWORD_SIGN_IN: config.get('CCMS_PASSWORD_SIGN_IN', {
        infer: true,
      }),
      CCMS_EMAIL_CODE_SIGN_IN: config.get('CCMS_EMAIL_CODE_SIGN_IN', {
        infer: true,
      }),
      CCMS_MAIL_URL: config.get('CCMS_MAIL_URL', { infer: true }),
      CCMS_AUTH_MODE: config.get('CCMS_AUTH_MODE', { infer: true }),
    };
    this.password = passwordSignInOn(ways);
    this.emailCode = emailCodeSignInOn(ways);
    this.editorUrl = editorUrlOf(env as Parameters<typeof editorUrlOf>[0]);
    const publicUrl = config.get('CCMS_PUBLIC_URL', { infer: true });
    this.origins = new Set([
      ...(this.editorUrl ? [new URL(this.editorUrl).origin] : []),
      ...(publicUrl ? [new URL(publicUrl).origin] : []),
      ...(config.get('CCMS_EDITOR_ORIGINS', { infer: true }) ?? []),
    ]);
    this.cookieSeconds =
      config.get('CCMS_SESSION_MAX_HOURS', { infer: true }) * 3600;
  }

  /**
   * Whether people's sessions count (#639): some way of signing in is on, a provider (`providers`,
   * how many there are), passwords or codes by email. Off, a session cookie is nothing: one left
   * from before is not read.
   */
  signInOn(providers: number): boolean {
    return providers > 0 || this.password || this.emailCode;
  }

  /**
   * The editor's address for `path` (a path inside it, `/…`, from
   * `safeReturnPath`): where to send the browser. Always under the editor's
   * address; anything that would leave it is the editor's start page.
   */
  editorAddress(path: string): string {
    const base = this.editorUrl ?? 'http://localhost/';
    // `./…`: resolved under the editor's path, never read as a scheme or host.
    const target = new URL(`./${path.replace(/^\/+/, '')}`, base);
    return target.origin === new URL(base).origin &&
      target.pathname.startsWith(new URL(base).pathname)
      ? target.href
      : base;
  }
}
