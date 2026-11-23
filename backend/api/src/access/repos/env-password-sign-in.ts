import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { editorUrlOf, passwordSignInOn } from '../../config/sign-in-env.js';
import { PasswordSignIn } from '../core/passwords.js';

/** Password sign-in's settings (#610) from the environment, read once. */
@Injectable()
export class EnvPasswordSignIn extends PasswordSignIn {
  readonly enabled: boolean;
  readonly inviteMs: number;
  readonly linkBase: string | null;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.enabled = passwordSignInOn({
      CCMS_PASSWORD_SIGN_IN: config.get('CCMS_PASSWORD_SIGN_IN', {
        infer: true,
      }),
      CCMS_AUTH_MODE: config.get('CCMS_AUTH_MODE', { infer: true }),
    });
    this.inviteMs =
      config.get('CCMS_INVITE_DAYS', { infer: true }) * 24 * 60 * 60 * 1000;
    this.linkBase =
      config.get('CCMS_PUBLIC_URL', { infer: true }) ??
      editorUrlOf({
        CCMS_EDITOR_URL: config.get('CCMS_EDITOR_URL', { infer: true }),
        CCMS_OIDC_REDIRECT_URL: config.get('CCMS_OIDC_REDIRECT_URL', {
          infer: true,
        }),
      } as Parameters<typeof editorUrlOf>[0]) ??
      null;
  }
}
