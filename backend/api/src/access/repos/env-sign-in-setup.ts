import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { IdentityProviders } from '../core/identity-provider.js';
import { SignInSetup } from '../core/sign-in-rules.js';

/** `SignInSetup` from the environment and the identity providers it names. */
@Injectable()
export class EnvSignInSetup extends SignInSetup {
  readonly sessionIdleMinutes: number;
  readonly sessionMaxHours: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly providers: IdentityProviders,
  ) {
    super();
    this.sessionIdleMinutes = config.get('CCMS_SESSION_IDLE_MINUTES', {
      infer: true,
    });
    this.sessionMaxHours = config.get('CCMS_SESSION_MAX_HOURS', {
      infer: true,
    });
  }

  get offered(): readonly string[] {
    return this.providers.list().map((provider) => provider.id);
  }
}
