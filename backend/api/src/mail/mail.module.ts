import {
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SecretSealer } from '../base/core/secret-sealer.js';
import { BrandingModule } from '../branding/branding.module.js';
import type { Env } from '../config/env.js';
import { MailController } from './api/mail.controller.js';
import { SendMailJobHandler } from './api/send-mail.handler.js';
import {
  GetMailSettingsAction,
  SendTestMailAction,
} from './core/actions/mail-settings.actions.js';
import {
  FailMailAction,
  SendMailAction,
} from './core/actions/send-mail.action.js';
import { MailOutbox } from './core/mail-outbox.js';
import {
  MailBrandSource,
  Mailer,
  MailSettings,
  MailStore,
} from './core/mail-ports.js';
import { BrandingMailBrand } from './repos/branding-mail-brand.js';
import { DrizzleMailStore } from './repos/drizzle-mail-store.js';
import { EnvMailSettings } from './repos/env-mail-settings.js';
import { SmtpMailer } from './repos/smtp-mailer.js';

/** A `Mailer` for no server: never called, as nothing is queued while email is off. */
class NoMailer extends Mailer {
  send(): Promise<void> {
    return Promise.reject(new Error('Email is off.'));
  }
}

/** Says once, at start-up, whether email is on, and why not when a server is set. */
@Injectable()
class MailStartup implements OnApplicationBootstrap {
  private readonly logger = new Logger('Mail');

  constructor(private readonly settings: MailSettings) {}

  onApplicationBootstrap(): void {
    const { server, state } = this.settings;
    if (server === null) return;
    if (state === 'no-secret-key') {
      this.logger.warn(
        'CCMS_MAIL_URL is set, but email is off: it needs the instance secret key (CCMS_SECRET_KEY, or the key file with CCMS_SECRET_KEY_GENERATE=true).',
      );
      return;
    }
    this.logger.log(
      `Email is on: ${server.host}:${server.port} (${server.tls}), from ${this.settings.from}.`,
    );
  }
}

/**
 * Email (#609): branded email through the installation's mail server. Other components queue
 * one with `MailOutbox.queue(tx, …)` in the transaction of what caused it; a `mail.send` job
 * renders and sends it (SMTP, `SmtpMailer`) with retries, then removes it. Admin › System ›
 * Email reads the settings (`GET /mail`) and sends a test email (`POST /mail/test`). Off while
 * `CCMS_MAIL_URL` is unset, or there is no secret key.
 */
@Module({
  imports: [AccessModule, AuditModule, BrandingModule],
  controllers: [MailController],
  providers: [
    {
      provide: MailSettings,
      inject: [ConfigService, SecretSealer],
      useFactory: (config: ConfigService<Env, true>, sealer: SecretSealer) =>
        new EnvMailSettings(config, sealer),
    },
    {
      provide: Mailer,
      inject: [MailSettings],
      useFactory: (settings: MailSettings) => {
        const smtp = (settings as EnvMailSettings).smtp;
        return smtp ? new SmtpMailer(smtp) : new NoMailer();
      },
    },
    { provide: MailStore, useClass: DrizzleMailStore },
    { provide: MailBrandSource, useClass: BrandingMailBrand },
    MailOutbox,
    SendMailAction,
    FailMailAction,
    GetMailSettingsAction,
    SendTestMailAction,
    SendMailJobHandler,
    MailStartup,
  ],
  exports: [MailOutbox],
})
export class MailModule {}
