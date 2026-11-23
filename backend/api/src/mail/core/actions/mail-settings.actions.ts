import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { UserDirectory } from '../../../access/core/user-directory.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  NotConfiguredError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { BOUNDED, UnitOfWork } from '../../../base/core/unit-of-work.js';
import { isMailAddress, type MailLanguage, mailSubject } from '../mail.js';
import { MailOutbox } from '../mail-outbox.js';
import {
  MailBrandSource,
  type MailServerInfo,
  MailSettings,
  type MailState,
} from '../mail-ports.js';

/** Who sees email's settings and sends the test email: the administrators. */
export const MANAGE_MAIL = 'admin.roles';

/** Email's settings as Admin › System › Email shows them: never the user or the password. */
export interface MailSettingsReport {
  readonly state: MailState;
  readonly server: MailServerInfo | null;
  readonly from: string | null;
  /** The sender's name: the branding's product name. */
  readonly senderName: string;
  readonly language: MailLanguage;
}

/** Email's settings (#609), read-only: they live in the environment. Needs `admin.roles`. */
@Injectable()
export class GetMailSettingsAction extends ActorAction<
  { actor: Actor },
  MailSettingsReport
> {
  readonly policy = MANAGE_MAIL;

  constructor(
    private readonly settings: MailSettings,
    private readonly brand: MailBrandSource,
  ) {
    super();
  }

  protected async run(): Promise<MailSettingsReport> {
    return {
      state: this.settings.state,
      server: this.settings.server,
      from: this.settings.from,
      senderName: await this.brand.productName(),
      language: this.settings.language,
    };
  }
}

/** The test email as queued. */
export interface QueuedTestMail {
  readonly id: string;
  readonly to: string;
  readonly language: MailLanguage;
}

/**
 * Queues the test email (#609) to the signed-in administrator's own address, in `language` (the
 * editor's, else the installation's), recorded as `mail.test` (the message ID). It is sent as
 * every email is (the job, its retries); a failure shows as `mail.failed`. 404 `not-configured`
 * while email is off (`meta.reason`: `off` or `no-secret-key`); 422 `no-email-address` for an
 * actor with no address (a service, a user without one). Needs `admin.roles`.
 */
@Injectable()
export class SendTestMailAction extends ActorAction<
  { actor: Actor; language?: string | null },
  QueuedTestMail
> {
  readonly policy = MANAGE_MAIL;

  constructor(
    private readonly settings: MailSettings,
    private readonly outbox: MailOutbox,
    private readonly users: UserDirectory,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run({
    actor,
    language,
  }: {
    actor: Actor;
    language?: string | null;
  }): Promise<QueuedTestMail> {
    const state = this.settings.state;
    if (state !== 'on') {
      throw new NotConfiguredError(
        state === 'off'
          ? 'Email is off: no mail server is set (CCMS_MAIL_URL).'
          : 'Email is off: it needs the instance secret key (CCMS_SECRET_KEY).',
        { reason: state },
      );
    }
    const user =
      actor.kind === 'user' ? await this.users.findUser(actor.id) : undefined;
    const address = user?.email ?? null;
    if (address === null || !isMailAddress(address)) {
      throw new UnprocessableError(
        'no-email-address',
        'You have no email address to send the test email to.',
      );
    }
    const queued = await this.unit.run(async (tx) => {
      const mail = await this.outbox.queue(tx, {
        to: { address, name: user?.name ?? null },
        template: 'test',
        params: {},
        language,
      });
      if (!mail) {
        throw new NotConfiguredError('Email is off.', { reason: 'off' });
      }
      await this.auditLog.record(tx, actor, {
        action: 'mail.test',
        subject: mailSubject(mail.id),
        data: { template: 'test' },
      });
      return mail;
    }, BOUNDED);
    return { id: queued.id, to: address, language: queued.language };
  }
}
