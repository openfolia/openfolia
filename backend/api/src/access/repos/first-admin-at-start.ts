import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { ServerRole } from '../../config/server-role.js';
import { StartupError } from '../../config/startup-error.js';
import { Database } from '../../database/database.js';
import type { Actor } from '../core/actor.js';
import { PasswordSignIn } from '../core/passwords.js';
import { IdentityProviders } from '../core/identity-provider.js';
import { RequestEmailCodeAction } from '../core/actions/email-code.action.js';
import { firstAdminIntoEmpty } from './first-admin-locally.js';

/**
 * How long the link logged at start-up works: one hour, not an invite's days, since logs are kept
 * and shipped (#373). `first-admin` on the command line makes a new one at any time.
 */
export const FIRST_ADMIN_LINK_MS = 60 * 60 * 1000;

/** The command that prints a new link, as the log and the guide name it. */
const NEW_LINK =
  'first-admin on the server (node dist/database/first-admin.main.js <email>; in a container: docker compose exec api …; deploy/README.md, "Quick start")';

/** Who the start-up's first admin is recorded as, in the audit log. */
export const STARTUP_ACTOR: Actor = Object.freeze({
  kind: 'service',
  id: 'service:startup',
  roles: Object.freeze([]),
}) as Actor;

/**
 * The first admin from the environment (#373): with `CCMS_FIRST_ADMIN_EMAIL` set, the API's
 * first start on an instance without users makes that user with the role `admin`
 * (`firstAdminIntoEmpty`) and, with password sign-in on, prints their one-time link to choose a
 * password in the log (with passwords off they sign in with the provider or, #639, by a code by
 * email, which the log says): valid one hour (`FIRST_ADMIN_LINK_MS`), closed by their first sign-in with
 * a provider or by email code too (`CompleteSignInAction`, `email-code.action.ts`), never logged with `CCMS_FIRST_ADMIN_LINK_LOG=false`. Once the instance has a user, the setting does nothing (said in the log),
 * so the path works once and is closed after. Only where migrations run (`api`, `all`), never on
 * a worker. A first admin that cannot be made (the role `admin` without `admin.roles`) stops the
 * start, saying why.
 */
@Injectable()
export class FirstAdminAtStart implements OnApplicationBootstrap {
  private readonly logger = new Logger('FirstAdmin');

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly role: ServerRole,
    private readonly database: Database,
    private readonly passwords: PasswordSignIn,
    private readonly providers: IdentityProviders,
    private readonly emailCode: RequestEmailCodeAction,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const email = this.config.get('CCMS_FIRST_ADMIN_EMAIL', { infer: true });
    if (email === undefined || !this.role.migrates) return;
    const logLink = this.config.get('CCMS_FIRST_ADMIN_LINK_LOG', {
      infer: true,
    });
    let made;
    try {
      made = await firstAdminIntoEmpty(this.database, {
        email,
        name: this.config.get('CCMS_FIRST_ADMIN_NAME', { infer: true }),
        inviteMs: FIRST_ADMIN_LINK_MS,
        linkBase: this.passwords.linkBase,
        withLink: this.passwords.enabled && logLink,
        actor: STARTUP_ACTOR,
        via: 'environment',
      });
    } catch (error) {
      throw new StartupError(
        `Cannot make the first admin from CCMS_FIRST_ADMIN_EMAIL: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (made === null) {
      this.logger.log(
        `CCMS_FIRST_ADMIN_EMAIL is ignored: the instance has users already (unset it). A new link to choose a password: ${NEW_LINK}.`,
      );
      return;
    }
    this.logger.log(
      `Made the first admin ${email} (user "${made.userId}") with the role "admin", from CCMS_FIRST_ADMIN_EMAIL.`,
    );
    if (made.link !== null) {
      this.logger.log(
        `Open this link to choose their password; it works once, within the hour (until ${made.link.expiresAt.toISOString()}), and closes when they sign in any other way. A new one: ${NEW_LINK}${this.passwords.linkBase === null ? '. Put the editor’s address in front of it (or set CCMS_PUBLIC_URL)' : ''}: ${made.link.url}`,
      );
    } else if (this.passwords.enabled) {
      this.logger.log(
        `No link in the log (CCMS_FIRST_ADMIN_LINK_LOG=false). Their link to choose a password: ${NEW_LINK}.`,
      );
    } else if (this.providers.list().length > 0 || this.emailCode.offered) {
      this.logger.log(
        [
          ...(this.providers.list().length > 0
            ? [
                'They sign in with the identity provider, under this email address (verified there).',
              ]
            : []),
          ...(this.emailCode.offered
            ? [
                'They sign in with a code by email: "Email me a code" on the sign-in page, with this address.',
              ]
            : []),
        ].join(' '),
      );
    } else {
      this.logger.warn(
        'Password sign-in is off, no identity provider is set up (CCMS_OIDC_ISSUER) and no code by email is offered (CCMS_EMAIL_CODE_SIGN_IN, CCMS_MAIL_URL): nobody can sign in yet.',
      );
    }
  }
}
