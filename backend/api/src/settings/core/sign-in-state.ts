import { Injectable } from '@nestjs/common';
import { SignInRules, SignInSetup } from '../../access/core/sign-in-rules.js';
import type {
  ShownInstallationSettings,
  StoredInstallationSettings,
} from './installation-settings.js';

/** Adds to the settings what those about signing in work on (#378). */
@Injectable()
export class SignInStates {
  constructor(
    private readonly rules: SignInRules,
    private readonly setup: SignInSetup,
  ) {}

  async show(
    stored: StoredInstallationSettings,
  ): Promise<ShownInstallationSettings> {
    const { breakGlassUserId } = stored.settings;
    const problem =
      breakGlassUserId === null
        ? null
        : await this.rules.breakGlassProblem(breakGlassUserId);
    return {
      ...stored,
      signIn: {
        singleSignOnAvailable: this.setup.offered.length > 0,
        // Deleted since: the setting itself empties with them.
        breakGlassProblem: problem === 'no-such-user' ? null : problem,
        serverSessionIdleMinutes: this.setup.sessionIdleMinutes,
        serverSessionMaxHours: this.setup.sessionMaxHours,
      },
    };
  }
}
