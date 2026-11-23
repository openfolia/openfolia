import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SecretSealer } from '../../base/core/secret-sealer.js';
import type { Transaction } from '../../base/core/unit-of-work.js';
import { JobQueue } from '../../jobs/core/job-queue.js';
import {
  headerText,
  isMailAddress,
  type MailLanguage,
  mailLanguage,
  type MailRecipient,
} from './mail.js';
import { SEND_MAIL } from './mail-job.js';
import { mailParamsContext, MailSettings, MailStore } from './mail-ports.js';
import {
  MAIL_TEMPLATES,
  type MailParams,
  type MailTemplateName,
} from './templates/templates.js';

/** What `MailOutbox.queue` sends. */
export interface MailRequest<N extends MailTemplateName> {
  readonly to: MailRecipient;
  readonly template: N;
  readonly params: MailParams<N>;
  /** The person's language, when known (`de`, `de-AT`); else the installation's. */
  readonly language?: string | null;
}

/** A queued email. */
export interface QueuedMail {
  readonly id: string;
  readonly language: MailLanguage;
}

/**
 * Queues an email inside the transaction of what caused it (the transactional outbox, #609): its
 * row (`mail_messages`, the params sealed under the instance key, as they may hold a sign-in
 * link) and its job (`mail.send`) commit with that change, or neither does. The job renders and
 * sends it, with retries, and removes the row: the email's body is never stored.
 *
 * Answers null, queuing nothing, while email is off (no mail server, or no secret key): a
 * caller then offers what the email would have carried another way (a link to copy). Throws
 * for a malformed address or params (a bug in the caller, or input it did not check).
 */
@Injectable()
export class MailOutbox {
  constructor(
    private readonly settings: MailSettings,
    private readonly store: MailStore,
    private readonly sealer: SecretSealer,
    private readonly jobs: JobQueue,
  ) {}

  /** Whether `queue` sends anything now. */
  get enabled(): boolean {
    return this.settings.state === 'on';
  }

  /**
   * Whether an email with a link into the editor can be sent (#610: invites, password
   * resets): email is on and `CCMS_PUBLIC_URL` says where the editor is.
   */
  get linksEnabled(): boolean {
    return this.enabled && this.settings.publicUrl !== null;
  }

  async queue<N extends MailTemplateName>(
    tx: Transaction,
    request: MailRequest<N>,
  ): Promise<QueuedMail | null> {
    if (!isMailAddress(request.to.address)) {
      throw new Error('Not an email address that can be sent to.');
    }
    const params = MAIL_TEMPLATES[request.template].params.parse(
      request.params,
    );
    if (!this.enabled) return null;
    const id = randomUUID();
    const language = mailLanguage(request.language, this.settings.language);
    await this.store.add(tx, {
      id,
      toAddress: request.to.address,
      toName: request.to.name ? headerText(request.to.name, 200) || null : null,
      template: request.template,
      language,
      paramsSealed: this.sealer.seal(
        JSON.stringify(params),
        mailParamsContext(id),
      ),
    });
    await this.jobs.enqueue(SEND_MAIL, { messageId: id }, { key: id, tx });
    return { id, language };
  }
}
