import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { errorLine } from '../../base/core/error-line.js';
import { ServerRole } from '../../config/server-role.js';
import { SIGN_IN_ACTOR } from '../core/actions/sign-in-links.action.js';
import { EndRefusedSignIns } from '../core/refused-sign-ins.js';
import {
  requiresSingleSignOn,
  SignInRules,
  SignInSetup,
} from '../core/sign-in-rules.js';

/** The commands that help when nobody can sign in, as the log and the guide name them. */
const WAY_BACK =
  'allow-other-sign-ins on the server (node dist/database/allow-other-sign-ins.main.js)';

/**
 * Says in the log at start-up when single sign-on is required (#378) and the server cannot offer
 * it any more: no identity provider is set up, or the break-glass account cannot be used. Ends what
 * is refused since the last start (a provider gone), so it does not come back with it.
 */
@Injectable()
export class SignInAtStart implements OnApplicationBootstrap {
  private readonly logger = new Logger('Sign-in');

  constructor(
    private readonly rules: SignInRules,
    private readonly setup: SignInSetup,
    private readonly refused: EndRefusedSignIns,
    private readonly role: ServerRole,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // What a process offers is its own environment's: only one that serves sign-ins speaks for them.
    if (!this.role.servesHttp) return;
    const rule = await this.rules.read();
    if (!requiresSingleSignOn(rule)) return;
    try {
      await this.refused.run(SIGN_IN_ACTOR);
    } catch (error) {
      // Each is refused at its next use all the same.
      this.logger.error(
        `What single sign-on refuses could not be ended: ${errorLine(error)}`,
      );
    }
    const problem = rule.breakGlass?.problem ?? null;
    if (problem !== null) {
      this.logger.warn(
        `The emergency account of single sign-on cannot be used (${problem}); choose another one in the project settings.`,
      );
    }
    if (this.setup.offered.length > 0) return;
    this.logger.warn(
      `Single sign-on is required, but no identity provider is set up: ${
        rule.breakGlass !== null && problem === null
          ? 'only the emergency account can sign in'
          : 'nobody can sign in'
      }. Set one up, or run ${WAY_BACK}.`,
    );
  }
}
