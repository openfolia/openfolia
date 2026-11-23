import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { StartupError } from '../../config/startup-error.js';
import { OpenSecretKeyAction } from '../core/actions/open-secret-key.action.js';
import { InstanceSecretKey } from '../core/instance-secret-key.js';
import { SecretKeyProblem } from '../core/secret-key.js';

/**
 * Opens and checks the instance secret key as the server starts (#470),
 * before any request or job (they start on `onApplicationBootstrap`). A
 * problem (`SecretKeyProblem`: the key lost or another one set while
 * sealed secrets exist) stops the start with a `StartupError` that says
 * what to do. Logs where the key came from, never the key.
 */
@Injectable()
export class SecretKeyGate implements OnModuleInit {
  private readonly logger = new Logger('SecretKey');

  constructor(
    private readonly openKey: OpenSecretKeyAction,
    private readonly key: InstanceSecretKey,
  ) {}

  async onModuleInit(): Promise<void> {
    let opened;
    try {
      opened = await this.openKey.handle();
    } catch (error) {
      if (error instanceof SecretKeyProblem) {
        throw new StartupError(`Cannot start: ${error.message}`, {
          cause: error,
        });
      }
      throw error;
    }
    this.key.use(opened);
    const { origin } = opened;
    if (origin.kind === 'environment') {
      if (origin.variable === 'CCMS_WEBHOOKS_SECRET_KEY') {
        this.logger.warn(
          'The secret key is set by CCMS_WEBHOOKS_SECRET_KEY, its old name: rename it to CCMS_SECRET_KEY.',
        );
      }
    } else if (origin.kind === 'file') {
      if (origin.created) {
        this.logger.log(
          `Made a new secret key in ${origin.path}. Back up this file: without it, stored secrets (webhook signing secrets) cannot be read.`,
        );
      } else if (opened.finishedRotation) {
        this.logger.log(
          `Finished an interrupted key rotation: ${origin.path} holds the new key.`,
        );
      }
    } else {
      this.logger.warn(
        'There is no secret key (CCMS_SECRET_KEY unset, CCMS_SECRET_KEY_GENERATE=false, no key file): webhooks are off.',
      );
    }
  }
}
