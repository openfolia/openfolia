import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { emailCodeSignInOn } from '../../config/sign-in-env.js';
import { EmailCodeSignIn } from '../core/email-codes.js';

/** Sign-in by email code's settings (#634) from the environment, read once. */
@Injectable()
export class EnvEmailCodeSignIn extends EmailCodeSignIn {
  readonly enabled: boolean;
  readonly lifetimeMs: number;
  readonly linkBase: string | null;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.enabled = emailCodeSignInOn({
      CCMS_EMAIL_CODE_SIGN_IN: config.get('CCMS_EMAIL_CODE_SIGN_IN', {
        infer: true,
      }),
      CCMS_PASSWORD_SIGN_IN: config.get('CCMS_PASSWORD_SIGN_IN', {
        infer: true,
      }),
      CCMS_MAIL_URL: config.get('CCMS_MAIL_URL', { infer: true }),
      CCMS_AUTH_MODE: config.get('CCMS_AUTH_MODE', { infer: true }),
    });
    this.lifetimeMs =
      config.get('CCMS_EMAIL_CODE_MINUTES', { infer: true }) * 60_000;
    // Emails link under the public URL only (`publicLink`): without one, the code alone.
    this.linkBase = config.get('CCMS_PUBLIC_URL', { infer: true }) ?? null;
  }
}
